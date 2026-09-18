import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TEAM-4749 A1 — caller/callee tool-signature parity.
 *
 * A fleet tool is two independently-deployed halves that never share a source
 * file and cannot import each other: a `@tool` wrapper in the runtime harness
 * (`deploy/runtime-agent/main.py`, Python) and a handler in a Lambda zip
 * (`lambda/<name>/index.mjs`, JavaScript). The wrapper's signature is also the tool
 * spec Strands ships to the model, so a name that exists on one side and not the
 * other has two distinct failure modes, neither of which any unit suite sees:
 *
 *   - The wrapper declares LESS than the Lambda reads → the blueprint tells a
 *     persona to pass an argument, Strands rejects the unknown keyword, and the
 *     capability is simply unreachable. That is exactly what shipped: the release
 *     manager was instructed to pass `base_branch="main"` on
 *     `Tickets___create_ticket` (blueprints/release-manager.md) against a
 *     signature that had no such parameter, so a hub-infra fix ticket could never
 *     be filed; and the pipeline-tools Lambda read `args.abandon` with no way for
 *     the wrapper to send it, so the `approval_stage_occupied` remedy was dead.
 *   - The wrapper forwards a key the Lambda does not read → the value is dropped
 *     in silence and the persona is told nothing.
 *
 * Both fail only in production, in one persona's turn, on a ship. So this file
 * reads BOTH sides as SOURCE TEXT — main.py cannot be imported from either
 * language, and these Lambdas construct AWS SDK clients at module scope, so
 * importing them here would need live credentials — and fails on a one-sided
 * rename. It is the name layer only; payload BEHAVIOUR (trimming, the
 * omit-when-blank rule, value coercion) is covered by the pytest suites that
 * `ast`-extract and exec the real function bodies:
 * `deploy/runtime-agent/tests/test_create_ticket_tool.py` and
 * `test_pipeline_ci_tools.py`. Same idiom and division of labour as
 * `follow-ups-parity.test.ts`.
 *
 * This file only READS the Lambdas. TEAM-4749 owns none of them.
 */

const REPO = join(__dirname, "..", "..", "..");
const mainPy = readFileSync(join(REPO, "deploy", "runtime-agent", "main.py"), "utf8");
const ticketsLambda = readFileSync(
  join(REPO, "lambda", "agentcore-hub-tickets", "index.mjs"),
  "utf8",
);
const jiraLambda = readFileSync(join(REPO, "lambda", "agentcore-hub-jira", "index.mjs"), "utf8");
const workflowOutputLambda = readFileSync(
  join(REPO, "lambda", "workflow-output", "index.mjs"),
  "utf8",
);
const pipelineToolsLambda = readFileSync(
  join(REPO, "lambda", "agentcore-hub-pipeline-tools", "index.mjs"),
  "utf8",
);

// ─── main.py extractors ──────────────────────────────────────────────────────

/** One `@tool` def, from its `def` line to the next top-level `def`/`@tool`, so a
 *  match elsewhere in the 5k-line file cannot satisfy an assertion below. */
function toolSource(name: string): string {
  const start = mainPy.indexOf(`def ${name}(`);
  expect(start, `${name} is not defined in main.py`).toBeGreaterThan(-1);
  const rest = mainPy.slice(start + 1);
  const end = rest.search(/\n@tool|\ndef /);
  return rest.slice(0, end === -1 ? undefined : end);
}

/** The docstring — which IS the tool spec the model reads. */
function toolDocstring(src: string): string {
  const open = src.indexOf('"""');
  const close = src.indexOf('"""', open + 3);
  expect(open, "tool has no docstring").toBeGreaterThan(-1);
  expect(close, "tool docstring is unterminated").toBeGreaterThan(open);
  return src.slice(open + 3, close);
}

/** Parameter NAMES off the `def` line. Deliberately separate from the forwarded
 *  keys below: ten of `Tickets___create_ticket`'s parameters are renamed or
 *  flattened before they are sent (`title`→`summary`, `parent_id`→`parent_key`,
 *  `ticket_type`→`issue_type`, the two `spawned_by_*`→`spawned_by`, and five
 *  contract fields→`fix_contract`), so asserting parameter names against Lambda
 *  reads would be wrong, not merely strict. Used only for the declared-with-a-
 *  blank-default pins. */
function toolParams(src: string): string[] {
  const open = src.indexOf("(");
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close, "unbalanced parens on the def line").toBeGreaterThan(open);
  return src
    .slice(open + 1, close)
    .split(",")
    .map((p) => p.split(":")[0].split("=")[0].trim())
    .filter((p) => p.length > 0 && p !== "self");
}

/** The depth-1 keys of ONE brace-delimited dict literal starting at `open`.
 *  Depth-1 only, so the nested `fix_contract` and origin-key maps inside
 *  `create_ticket`'s payload are not mistaken for payload fields. */
function dictLiteralKeys(src: string, open: number, into: Set<string>): void {
  let depth = 0;
  let close = src.length;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i + 1;
        break;
      }
    }
  }
  let d = 0;
  for (const m of src.slice(open, close).matchAll(/[{}]|["']([a-z_0-9]+)["']\s*:/g)) {
    if (m[0] === "{") d++;
    else if (m[0] === "}") d--;
    else if (d === 1) into.add(m[1]);
  }
}

/** The payload KEYS a wrapper actually sends. Three shapes are in use across
 *  these wrappers, and all three count — building this from the body rather than
 *  the signature is the whole reason the rename cases above do not produce false
 *  failures:
 *
 *    1. a named `payload = {…}` / `args = {…}` literal (create_ticket, start_deploy);
 *    2. later `payload["…"] = ` / `args["…"] = ` assignments (the additive fields);
 *    3. a dict literal passed INLINE to `_invoke_lambda(LAMBDA, "Tool", {…})`
 *       (add_comment, get_issue, list_tickets — the short wrappers).
 *
 *  Shape 3 was missing at first and made this extractor return an EMPTY set for
 *  add_comment, i.e. it would have passed vacuously on the very tool the sibling
 *  sweep was checking. Hence the non-empty assertion in the self-checks. */
function forwardedKeys(src: string): Set<string> {
  const keys = new Set<string>();
  for (const m of src.matchAll(/(?:payload|args)\[\s*["']([a-z_0-9]+)["']\s*\]\s*=/g)) {
    keys.add(m[1]);
  }
  const named = /\n\s*(?:payload|args)\s*=\s*\{/.exec(src);
  if (named) dictLiteralKeys(src, src.indexOf("{", named.index), keys);
  for (const m of src.matchAll(/_invoke_lambda\s*\([^,]+,\s*"[A-Za-z_0-9]+___[a-z_0-9]+"\s*,\s*\{/g)) {
    dictLiteralKeys(src, src.indexOf("{", m.index + m[0].length - 1), keys);
  }
  return keys;
}

// ─── Lambda extractors ───────────────────────────────────────────────────────
//
// Three read styles, verified one by one rather than assumed — which is why this
// is two extractors and not one clever regex.

/** `const { a, b: c, d = 1 } = args;` (tickets, jira) and a destructured
 *  PARAMETER object `async function reportCompletion({ a, b })` (workflow-output).
 *  Aliases and defaults are stripped: the WIRE name is the left-hand side. */
function destructuredKeys(source: string, anchor: RegExp, label: string): Set<string> {
  const m = anchor.exec(source);
  expect(m, `${label}: the destructure anchor did not match — the extractor is stale`).not.toBeNull();
  const keys = new Set<string>();
  for (const raw of m![1].split(",")) {
    const name = raw.split(":")[0].split("=")[0].trim();
    if (name) keys.add(name);
  }
  return keys;
}

/** `args.<key>` property reads, unioned FILE-WIDE. `startDeploy` hands its whole
 *  `args` object to `resolveTarget(args)` and `recordShipApproval(args, …)`, so a
 *  per-function slice would miss `pipeline_name`/`approved_head_sha`/`pr_url`/
 *  `ci_build_id` and would break on the next harmless refactor. The cost is that
 *  the set spans every tool in that Lambda (`scan`, `tail_lines`, `build_id` …),
 *  so it is sound for "is this key read at all" and NOT usable in reverse — hence
 *  the curated agent-facing list for this Lambda instead of a subtraction. */
function argsPropertyReads(source: string): Set<string> {
  const keys = new Set<string>();
  for (const m of source.matchAll(/\bargs\??\.([a-z][a-z_0-9]*)\b/g)) keys.add(m[1]);
  return keys;
}

/** One `async function <name>(…)` slice out of a Lambda, to the next top-level
 *  `async function`. Needed for the per-tool handlers below: unlike
 *  `createTicket`/`reportCompletion`, the comment and transition handlers read a
 *  handful of keys by property access, so a file-wide union would say "yes, some
 *  tool in this zip reads that" — which is exactly the question that misses a
 *  per-tool mismatch. */
function lambdaFunctionSource(source: string, name: string, label: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${label}: async function ${name} not found — the extractor is stale`).toBeGreaterThan(
    -1,
  );
  const rest = source.slice(start);
  const end = rest.indexOf("\nasync function ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every `Tickets___*` tool name main.py actually invokes on the ticket-tools
 *  Lambda. The tool NAME is the dispatch key, so this is the set that has to be
 *  routable — a name neither twin knows is a tool that always errors. */
function invokedTicketToolNames(): Set<string> {
  const names = new Set<string>();
  for (const m of mainPy.matchAll(/TICKET_TOOLS_LAMBDA,\s*"(Tickets___[a-z_0-9]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

/** The DDB twin dispatches on `toolName.split("___").pop()` and a `switch`, so
 *  its routable names are the STRIPPED case labels. */
function ddbSwitchCases(): Set<string> {
  const cases = new Set<string>();
  for (const m of ticketsLambda.matchAll(/\n\s*case "([a-z_0-9]+)":/g)) cases.add(m[1]);
  return cases;
}

/** The Jira twin dispatches on `TOOLS[event.tool_name]` — a lookup on the FULL,
 *  unstripped name. Two different dispatch schemes over one tool interface is
 *  precisely why a name can be routable on one twin and not the other. */
function jiraToolsMapKeys(): Set<string> {
  const keys = new Set<string>();
  for (const m of jiraLambda.matchAll(/\n\s*(Tickets___[a-z_0-9]+):\s*[A-Za-z]/g)) keys.add(m[1]);
  return keys;
}

const ticketsRead = destructuredKeys(
  ticketsLambda,
  /async function createTicket\(args\)\s*\{\s*const \{([^}]*)\} = args;/,
  "agentcore-hub-tickets createTicket",
);
const jiraRead = destructuredKeys(
  jiraLambda,
  /async function createTicket\(params\)\s*\{\s*const \{([^}]*)\} = params;/,
  "agentcore-hub-jira createTicket",
);
const workflowOutputRead = destructuredKeys(
  workflowOutputLambda,
  /async function reportCompletion\(\{([^}]*)\}\)/,
  "workflow-output reportCompletion",
);
const pipelineToolsRead = argsPropertyReads(pipelineToolsLambda);

const createTicketSrc = toolSource("Tickets___create_ticket");
const startDeploySrc = toolSource("Pipeline___start_deploy");
const reportCompletionSrc = toolSource("WorkflowOutput___report_completion");

const createTicketFwd = forwardedKeys(createTicketSrc);
const startDeployFwd = forwardedKeys(startDeploySrc);
const reportCompletionFwd = forwardedKeys(reportCompletionSrc);

/** Keys the Lambda reads that an agent is deliberately NOT given a way to set.
 *  Each needs a reason, or this set becomes the hole the test is meant to close. */
const NOT_AGENT_FACING: Record<string, string> = {
  // Both derived server-side in the tickets Lambda from env/convention. A persona
  // choosing its own Jira project or priority is not a capability we want.
  project_key: "derived from the JIRA_PROJECT_KEY env var, never agent-chosen",
  priority: "left to the tracker's default; no persona ranks its own ticket",
};

describe("tool-signature parity — extractor self-checks", () => {
  /**
   * A source-text test that stops matching passes vacuously, which is worse than
   * no test: it reports green over the exact drift it was written to catch. So
   * every extractor is asserted to have found something first.
   */
  it("found every tool in main.py and every arg read in every Lambda", () => {
    expect(toolParams(createTicketSrc).length).toBeGreaterThan(10);
    expect(toolParams(startDeploySrc).length).toBeGreaterThan(5);
    expect(toolParams(reportCompletionSrc).length).toBeGreaterThan(10);

    expect(createTicketFwd.size).toBeGreaterThan(10);
    expect(startDeployFwd.size).toBeGreaterThan(5);
    expect(reportCompletionFwd.size).toBeGreaterThan(15);

    expect(ticketsRead.size).toBeGreaterThan(10);
    expect(jiraRead.size).toBeGreaterThan(10);
    expect(workflowOutputRead.size).toBeGreaterThan(15);
    expect(pipelineToolsRead.size).toBeGreaterThan(5);
  });

  it("the two ticket twins read the same keys, minus the tickets-only defaults", () => {
    // Not a parity claim about this ticket's change — a check that the twins are
    // still twins, because every assertion below that names "both twins" is only
    // meaningful while that holds.
    const onlyTickets = [...ticketsRead].filter((k) => !jiraRead.has(k)).sort();
    expect(onlyTickets).toEqual(Object.keys(NOT_AGENT_FACING).sort());
    expect([...jiraRead].filter((k) => !ticketsRead.has(k))).toEqual([]);
  });
});

describe("tool-signature parity — forwarded keys reach their Lambda", () => {
  /**
   * Direction 1: everything the harness SENDS is something the Lambda READS.
   * Catches a rename on the Lambda side, which otherwise drops the value in
   * silence.
   */
  const cases: Array<[string, Set<string>, Set<string>, string]> = [
    ["Tickets___create_ticket", createTicketFwd, ticketsRead, "agentcore-hub-tickets"],
    ["Tickets___create_ticket", createTicketFwd, jiraRead, "agentcore-hub-jira"],
    ["Pipeline___start_deploy", startDeployFwd, pipelineToolsRead, "agentcore-hub-pipeline-tools"],
    [
      "WorkflowOutput___report_completion",
      reportCompletionFwd,
      workflowOutputRead,
      "workflow-output",
    ],
  ];

  for (const [tool, forwarded, read, lambda] of cases) {
    it(`every key ${tool} forwards is read by ${lambda}`, () => {
      const unread = [...forwarded].filter((k) => !read.has(k)).sort();
      expect(
        unread,
        `${tool} forwards ${unread.join(", ")}, which ${lambda} never reads — ` +
          `either the harness invented a key or the Lambda renamed one`,
      ).toEqual([]);
    });
  }
});

describe("tool-signature parity — agent-facing keys are declarable", () => {
  /**
   * Direction 2, and the one that fails on the A1 defect: a key the Lambda reads
   * from an AGENT, with no way for the agent to send it, is an unreachable
   * capability. Run against the two Lambdas whose reads are a single explicit
   * destructure of one tool's args; the pipeline-tools union spans every tool in
   * that zip, so `abandon` is pinned by name below instead.
   */
  it("every agent-facing key the tickets Lambda reads can be sent", () => {
    const missing = [...ticketsRead]
      .filter((k) => !(k in NOT_AGENT_FACING) && !createTicketFwd.has(k))
      .sort();
    expect(
      missing,
      `agentcore-hub-tickets reads ${missing.join(", ")} but Tickets___create_ticket ` +
        `cannot send them: a persona told to pass one gets a rejected keyword. Add the ` +
        `parameter, or document it in NOT_AGENT_FACING with a reason`,
    ).toEqual([]);
  });

  it("every key the jira twin reads can be sent", () => {
    const missing = [...jiraRead].filter((k) => !createTicketFwd.has(k)).sort();
    expect(missing).toEqual([]);
  });

  it("every key workflow-output reads can be sent", () => {
    const missing = [...workflowOutputRead].filter((k) => !reportCompletionFwd.has(k)).sort();
    expect(missing).toEqual([]);
  });
});

describe("tool-signature parity — the three at-risk arguments", () => {
  /**
   * One pin per argument that has drifted or could, each asserting all three
   * links at once: DECLARED on the def line, FORWARDED by the body, and READ by
   * the Lambda. A pin is what makes a regression name itself instead of showing
   * up as a set difference.
   */
  it("base_branch reaches both ticket twins", () => {
    expect(toolParams(createTicketSrc)).toContain("base_branch");
    // A blank default is what keeps every pre-4749 call byte-identical.
    expect(createTicketSrc).toMatch(/base_branch:\s*str\s*=\s*""/);
    // The literal wire spelling, on both sides. `baseBranch` would be dropped.
    expect(createTicketFwd).toContain("base_branch");
    expect(createTicketSrc).not.toMatch(/\bbaseBranch\b/);
    expect(ticketsRead).toContain("base_branch");
    expect(jiraRead).toContain("base_branch");
    // Forwarded only when non-blank: an always-present "" would make "no branch
    // stated" indistinguishable from a branch, and both twins validate the value
    // before minting an id.
    expect(createTicketSrc).toMatch(/if\s+base_branch\.strip\(\):/);
    // The model only ever learns this argument from the docstring.
    expect(toolDocstring(createTicketSrc)).toMatch(/base_branch:/);
  });

  it("abandon reaches pipeline-tools and promises no approval", () => {
    expect(toolParams(startDeploySrc)).toContain("abandon");
    expect(startDeploySrc).toMatch(/abandon:\s*str\s*=\s*""/);
    expect(startDeployFwd).toContain("abandon");
    expect(pipelineToolsRead).toContain("abandon");

    // The Lambda's coercion is STRICT — `args.abandon === true || args.abandon === "true"`,
    // not JS truthiness — so forwarding an agent's "1"/"yes" verbatim would silently
    // fail to opt in, which is the worst outcome: the agent believes it asked. The
    // wrapper normalizes to a real boolean and omits everything else.
    expect(startDeploySrc).toMatch(/abandon\.strip\(\)\.lower\(\)\s+in\s*\(/);
    expect(startDeploySrc).toMatch(/args\[\s*["']abandon["']\s*\]\s*=\s*True/);
    expect(pipelineToolsLambda).toMatch(
      /args\.abandon\s*===\s*true\s*\|\|\s*args\.abandon\s*===\s*"true"/,
    );

    // No new approval surface. DL-028: the in-pipeline deploy gate is human-only,
    // and `approved_head_sha` is the ONE parameter here whose name may mention
    // approval — it is evidence the pipeline re-verifies, not an approval.
    const approvalish = toolParams(startDeploySrc).filter(
      (p) => /approv/i.test(p) && p !== "approved_head_sha",
    );
    expect(approvalish, "a new approval-shaped parameter appeared on start_deploy").toEqual([]);

    const doc = toolDocstring(startDeploySrc);
    expect(doc).toMatch(/abandon:/);
    // The docstring must state the real contract: opt-in only, and a refusal
    // starts nothing. A persona that reads `abandon` as "make the wait stop" is
    // the double-deploy this whole branch exists to prevent.
    expect(doc).toMatch(/not an approval capability/i);
    expect(doc).toMatch(/approval_stage_occupied/);
    for (const reason of [
      "ancestry_unproven",
      "gate_no_longer_occupied",
      "abandon_not_permitted",
      "abandon_unconfirmed",
    ]) {
      expect(doc, `the docstring does not name the ${reason} refusal`).toContain(reason);
    }
  });

  it("follow_ups reaches workflow-output", () => {
    // TEAM-4740's receiving half has landed on this base branch, so unlike the
    // skipIf in follow-ups-parity.test.ts this is asserted unconditionally.
    expect(toolParams(reportCompletionSrc)).toContain("follow_ups");
    expect(reportCompletionFwd).toContain("follow_ups");
    expect(workflowOutputRead).toContain("follow_ups");
    expect(reportCompletionSrc).not.toMatch(/\bfollowUps\b/);
  });
});

describe("tool-signature parity — the other Tickets___* tools reach both twins", () => {
  /**
   * TEAM-4749 sibling sweep. The two ticket Lambdas are meant to expose ONE
   * identical `Tickets___*` interface (CLAUDE.md), and the checks above only
   * covered `create_ticket`. Two independent things have to line up per tool, and
   * the twins do each of them differently, so each gets its own assertion:
   *
   *   1. the tool NAME has to be routable — the DDB twin strips `___` and
   *      switches on the tail, the Jira twin looks up the full name in a map;
   *   2. the payload KEYS have to be the ones that twin's handler reads.
   *
   * Both mismatches return an error string to the persona and write nothing, and
   * neither unit suite could see them.
   */
  const invoked = invokedTicketToolNames();
  const ddbCases = ddbSwitchCases();
  const jiraKeys = jiraToolsMapKeys();

  it("found the invoked names and both twins' dispatch tables", () => {
    // Vacuity guard — any of these passing empty would make every assertion
    // below meaningless. The forwardedKeys checks are here because the extractor
    // DID return empty for these wrappers at first: they pass their payload
    // inline to _invoke_lambda instead of building a named `args` dict, so the
    // "add_comment sends both names" test passed vacuously until shape 3 was
    // added. A parity test that cannot fail is worse than no parity test.
    expect(invoked.size).toBeGreaterThan(5);
    expect(ddbCases.size).toBeGreaterThan(5);
    expect(jiraKeys.size).toBeGreaterThan(5);
    for (const tool of [
      "Tickets___add_comment",
      "Tickets___transition_ticket",
      "Tickets___update_ticket",
      "Tickets___get_issue",
    ]) {
      expect(
        forwardedKeys(toolSource(tool)).size,
        `forwardedKeys extracted nothing from ${tool} — the extractor is stale`,
      ).toBeGreaterThan(1);
    }
  });

  /**
   * Names the DDB twin cannot route. `update_ticket` is a REAL, live gap, not a
   * naming choice: main.py invokes `Tickets___update_ticket`, the DDB twin strips
   * that to `update_ticket` and its switch has only `edit_issue`, so the call
   * lands on the default `Unknown tool` branch. It is not fixable from the
   * wrapper — the Jira twin's map has `Tickets___update_ticket` and NO
   * `edit_issue` entry at all, so renaming the invoke to `Tickets___edit_issue`
   * would simply move the breakage to the shipped provider. The fix is a
   * one-line `case "update_ticket":` alias in the DDB twin, which TEAM-4749 does
   * not own. Tracked here so the gap is a named exception instead of a silence,
   * and so any NEW unroutable tool fails this test.
   */
  const DDB_ROUTING_GAPS: Record<string, string> = {
    Tickets___update_ticket:
      "DDB twin has case 'edit_issue' but no 'update_ticket'; Jira twin has no " +
      "'edit_issue', so no single name routes on both. Needs a DDB-side alias.",
  };

  it("every invoked tool name is routable by the DynamoDB twin", () => {
    const unroutable = [...invoked]
      .filter((n) => !ddbCases.has(n.split("___").pop()!) && !(n in DDB_ROUTING_GAPS))
      .sort();
    expect(
      unroutable,
      `main.py invokes ${unroutable.join(", ")} but the DynamoDB twin's switch has no ` +
        `matching case, so the call returns "Unknown tool" and writes nothing. Add the ` +
        `case, or record it in DDB_ROUTING_GAPS with a reason`,
    ).toEqual([]);
  });

  it("every invoked tool name is routable by the Jira twin", () => {
    // No exceptions list here on purpose: the Jira twin is the shipped provider
    // (Dockerfile / .env.example set TICKET_PROVIDER=jira), so an unroutable name
    // here is a production outage, never a tracked gap.
    const unroutable = [...invoked].filter((n) => !jiraKeys.has(n)).sort();
    expect(
      unroutable,
      `main.py invokes ${unroutable.join(", ")} but the Jira twin's TOOLS map has no such ` +
        `key — that is the shipped provider, so this is live`,
    ).toEqual([]);
  });

  it("the recorded DynamoDB routing gaps are still real", () => {
    // A tracked exception that gets fixed must stop being an exception, or this
    // list quietly becomes a place where real drift can hide.
    for (const [name, why] of Object.entries(DDB_ROUTING_GAPS)) {
      expect(invoked, `${name} is in DDB_ROUTING_GAPS but main.py no longer invokes it`).toContain(
        name,
      );
      expect(
        ddbCases.has(name.split("___").pop()!),
        `${name} now routes on the DynamoDB twin — delete it from DDB_ROUTING_GAPS (${why})`,
      ).toBe(false);
    }
  });

  it("add_comment sends the text under both wire names", () => {
    /**
     * The twins disagree on the key for a comment's text, so the wrapper sends
     * both — the same fix `Tickets___get_issue` already uses for `ticket_id` vs
     * `issue_key`. Before it, every comment in TICKET_PROVIDER=dynamodb mode came
     * back "Error: 'body' is required" and wrote nothing; dynamodb is the code
     * default when the var is unset (deploy/setup-tickets-lambda.mjs).
     */
    const addCommentFwd = forwardedKeys(toolSource("Tickets___add_comment"));
    const ddbAddComment = lambdaFunctionSource(ticketsLambda, "addComment", "tickets twin");
    const jiraAddComment = lambdaFunctionSource(jiraLambda, "addComment", "jira twin");

    // Each twin's own read, asserted rather than assumed.
    expect(argsPropertyReads(ddbAddComment)).toContain("body");
    expect(jiraAddComment).toMatch(/const \{[^}]*\bcomment\b[^}]*\} = params;/);

    // ...and the payload satisfies both at once.
    expect(addCommentFwd).toContain("comment");
    expect(addCommentFwd).toContain("body");
    expect(addCommentFwd).toContain("ticket_id");
  });

  it("transition_ticket's arguments are read by both twins", () => {
    const fwd = forwardedKeys(toolSource("Tickets___transition_ticket"));
    const ddbTransition = lambdaFunctionSource(ticketsLambda, "transitionIssue", "tickets twin");
    const jiraTransition = lambdaFunctionSource(jiraLambda, "transitionTicket", "jira twin");

    // `blocked_by` is the typed-gate parking argument and `reason` is the audit
    // line — a persona is told to pass both, so both must survive the crossing.
    for (const key of ["reason", "blocked_by"]) {
      expect(fwd, `transition_ticket no longer forwards ${key}`).toContain(key);
      expect(
        argsPropertyReads(ddbTransition).has(key) || new RegExp(`\\b${key}\\b`).test(ddbTransition),
        `the DynamoDB twin's transitionIssue no longer reads ${key}`,
      ).toBe(true);
      expect(jiraTransition, `the Jira twin's transitionTicket no longer reads ${key}`).toMatch(
        new RegExp(`\\b${key}\\b`),
      );
    }
    // The ticket key needs one spelling only: Jira destructures `ticket_id` and
    // the DDB twin reads `issue_key || ticket_id`.
    expect(fwd).toContain("ticket_id");
    expect(ddbTransition).toMatch(/args\.issue_key \|\| args\.ticket_id/);
  });

  it("update_ticket's payload matches the twin that can actually route it", () => {
    /**
     * Keys only — the DDB routing gap above means its handler is unreachable, so
     * pinning `title` against `editIssue`'s `args.summary` would assert a contract
     * nothing exercises. What IS live is the Jira twin, and it destructures the
     * three keys the wrapper sends.
     */
    const fwd = forwardedKeys(toolSource("Tickets___update_ticket"));
    const jiraUpdate = lambdaFunctionSource(jiraLambda, "updateTicket", "jira twin");
    for (const key of ["ticket_id", "description", "title"]) {
      expect(fwd, `update_ticket no longer forwards ${key}`).toContain(key);
      expect(jiraUpdate, `the Jira twin's updateTicket no longer reads ${key}`).toMatch(
        new RegExp(`\\b${key}\\b`),
      );
    }
    // The DDB twin's editIssue reads `summary`, not `title` — recorded so that
    // whoever lands the routing alias knows the payload needs a second spelling
    // too, exactly like add_comment above.
    expect(
      lambdaFunctionSource(ticketsLambda, "editIssue", "tickets twin"),
    ).toMatch(/args\.summary/);
  });
});

describe("tool-signature parity — the release manager's blueprint spells them right", () => {
  /**
   * The blueprint is the ONLY place a persona learns an argument exists, so a
   * blueprint that names an argument the signature does not have is the A1 defect
   * with the sides swapped — and it fails just as invisibly.
   */
  const releaseManager = readFileSync(join(REPO, "blueprints", "release-manager.md"), "utf8");

  it("every tool argument the blueprint tells the RM to pass exists", () => {
    for (const m of releaseManager.matchAll(/`?([a-z_][a-z_0-9]*)="[^"]*"`?/g)) {
      const arg = m[1];
      if (arg !== "base_branch" && arg !== "abandon") continue;
      const declared =
        toolParams(createTicketSrc).includes(arg) || toolParams(startDeploySrc).includes(arg);
      expect(declared, `release-manager.md tells the RM to pass ${arg}=… but no tool declares it`).toBe(
        true,
      );
    }
  });

  it("distinguishes the abandon ARGUMENT from abandoning the wait", () => {
    // release-manager.md already used the word "Abandon" for a different act —
    // give up waiting and file a gate:blocker ticket. Introducing an `abandon`
    // argument without separating the two would make the RM conflate them, which
    // is worse than the gap it closes.
    expect(releaseManager).toMatch(/`abandon` \(the argument\) is NOT "abandon the wait"/);
  });
});
