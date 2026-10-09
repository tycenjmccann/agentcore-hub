import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4739 WP2 replay — the three gate closes that were taken on faith.
 *
 * It lives in the tickets twin because the guard does: "may this gate ticket
 * close?" is answered inside `transition_ticket`, so a replay that mocked the
 * orchestrator would be replaying the wrong process. Mocked here: the AWS seams
 * only (DynamoDB doc client, S3, and the pipeline-tools Lambda the probe calls).
 * The guard, `gate-contract.mjs`, and every refusal string are the real ones.
 *
 *   p5ogpg / TEAM-4655  the release manager transitioned its deploy-approval gate
 *                       to `done` while the pipeline's approval action was still
 *                       parked and unanswered. The cascade then dispatched the
 *                       ship work over an approval no human had given.
 *                       ⇒ refused, ticket unmoved, ONE gate.repaged, no ticket
 *                         created, and nothing for the cascade to dispatch on.
 *   37ule1 / TEAM-4650  a `gate:ci-unavailable` gate closed for commit eb71dbb...
 *                       when CI had simply never been asked to build that SHA,
 *                       and the ticket carried no DECISION line.
 *                       ⇒ refused, and NO CI re-certification ticket is filed:
 *                         the remedy is to start the build.
 *   37ule1              the same gate re-filed a SECOND time against the same kind,
 *                       blocked_by and head — the environmental loop (FR-2: one
 *                       prior already proves the re-file is not new work).
 *                       ⇒ gate_loop_environmental + ONE
 *                         workflow.blocked{reason:"environmental", attempt:2}; every
 *                         later attempt refuses identically and emits nothing.
 */

const h = vi.hoisted(() => ({
  state: {
    items: /** @type {Record<string, any>} */ ({}),
    puts: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    statusUpdates: /** @type {any[]} */ ([]),
    labelUpdates: /** @type {any[]} */ ([]),
    condFail: /** @type {string[]} */ ([]),
    siblings: /** @type {any[]} */ ([]),
    comments: /** @type {any[]} */ ([]),
    counter: 0,
    probes: /** @type {any[]} */ ([]),
    probeBy: /** @type {Record<string, {result?: unknown}>} */ ({}),
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      h.state.probes.push({ tool: req.tool_name, args: req.parameters });
      const plan = h.state.probeBy[req.tool_name];
      if (!plan) {
        const err = new Error("connect ETIMEDOUT");
        err.name = "TimeoutError";
        throw err;
      }
      // The real tools Lambda double-encodes (`jsonResult`).
      return {
        Payload: Buffer.from(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(plan.result, null, 2) }] })
        ),
      };
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      const err = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; this.__type = "GetObject"; } },
  HeadObjectCommand: class { constructor(i) { this.input = i; this.__type = "HeadObject"; } },
}));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          if (name === "UpdateCommand") {
            const label = cmd.input.ExpressionAttributeValues?.[":label"];
            if (label !== undefined) {
              h.state.labelUpdates.push(cmd.input);
              if (h.state.condFail.includes(label)) {
                const err = new Error("The conditional request failed");
                err.name = "ConditionalCheckFailedException";
                throw err;
              }
              return {};
            }
            if (cmd.input.ExpressionAttributeValues?.[":s"] !== undefined) {
              h.state.statusUpdates.push(cmd.input);
              return {};
            }
            const comment = cmd.input.ExpressionAttributeValues?.[":comment"];
            if (comment !== undefined) {
              h.state.comments.push(...comment);
              return {};
            }
            // `nextTicketId`'s ADD-shaped counter bump: the one write that means
            // "a ticket is about to exist".
            h.state.counter += 1;
            return { Attributes: { nextNum: h.state.counter } };
          }
          if (name === "GetCommand") return { Item: h.state.items[cmd.input.Key.ticketId] };
          if (name === "PutCommand") {
            if (cmd.input.Item?.eventId) h.state.events.push(cmd.input.Item);
            else h.state.puts.push(cmd.input.Item);
            return {};
          }
          if (name === "QueryCommand") return { Items: h.state.siblings };
          return {};
        },
      }),
    },
  };
});

let handler;
const transition = (args) => handler({ name: "Tickets___transition_ticket", arguments: args });
const create = (args) => handler({ name: "Tickets___create_ticket", arguments: args });

beforeEach(async () => {
  const s = h.state;
  s.items = {};
  s.puts.length = 0;
  s.events.length = 0;
  s.statusUpdates.length = 0;
  s.labelUpdates.length = 0;
  s.condFail.length = 0;
  s.siblings.length = 0;
  s.comments.length = 0;
  s.counter = 0;
  s.probes.length = 0;
  s.probeBy = {};
  delete process.env.ARTIFACT_BUCKET;
  // The replayed installs had the pipeline module deployed — that is what makes
  // the probe answerable, and an answered probe is what makes a refusal possible.
  process.env.PIPELINE_TOOLS_LAMBDA = "hub-pipeline-tools";
  process.env.EVENTS_TABLE = "agentcore-hub-events";
  process.env.AWS_REGION = "us-east-1";
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

describe("replay p5ogpg / TEAM-4655 — a deploy gate closed over a parked approval", () => {
  const GATE = "TEAM-4655";
  const PIPELINE = "hub-agentcore-hub-deploy";
  const EXEC = "9c3a1f27-4b1e-4f4a-9a2d-6f7e5c8b0a11";
  const LABELS = ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`];

  const gateRow = (labels = LABELS) => ({
    ticketId: GATE,
    status: "in_review",
    assignee: "human:tycen",
    labels,
    workflowId: "p5ogpg",
    parentId: "TEAM-4640",
    description: "Approve the production deploy for the TEAM-4640 epic.",
  });

  /** The pipeline as it actually stood: our execution parked on the approval. */
  const parkedApproval = {
    result: {
      waitingOn: { kind: "human_approval", stage: "Deploy", action: "ApproveDeploy", executionId: EXEC, holdsGate: "this" },
      actionDetails: [{ stage: "Deploy", action: "ApproveDeploy", status: "InProgress" }],
    },
  };

  it("refuses the close, leaves the ticket, pages once, files nothing", async () => {
    h.state.probeBy.Pipeline___get_state = parkedApproval;
    h.state.items[GATE] = gateRow();

    const res = await transition({ ticket_id: GATE, to_status: "done" });

    expect(res).toMatchObject({ ok: false, reason: "gate_condition_unmet", stage: "Deploy", action: "ApproveDeploy" });
    expect(res.hint).toContain("still OPEN");
    // The probe was execution-scoped: this run's approval, not the pipeline's mood.
    expect(h.state.probes).toEqual([
      { tool: "Pipeline___get_state", args: { pipeline_name: PIPELINE, execution_id: EXEC } },
    ]);
    // NOTHING moved. No status write means no stream record, which means the
    // cascade is never handed a done gate to dispatch downstream work over -
    // the actual harm in the original run.
    expect(h.state.statusUpdates).toHaveLength(0);
    // And a refused gate is not answered by filing another gate.
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter, "no ticket id was minted").toBe(0);
    // One page: the parked-gate label, ONE comment with the console link the
    // human needs, and exactly one gate.repaged.
    expect(h.state.labelUpdates.map((u) => u.ExpressionAttributeValues[":label"]))
      .toEqual(["gate:awaiting-console"]);
    expect(h.state.comments).toHaveLength(1);
    expect(h.state.comments[0].content).toContain(res.consoleUrl);
    expect(res.consoleUrl).toContain(PIPELINE);
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0].type).toBe("gate.repaged");
    expect(h.state.events[0].detail).toMatchObject({ ticketId: GATE, gateKind: "deploy-approval", attempt: 1 });
    expect(h.state.events[0].workflowId, "run id off the ROW, never an argument").toBe("p5ogpg");
  });

  it("retrying immediately repeats the refusal and pages a SECOND time never", async () => {
    h.state.probeBy.Pipeline___get_state = parkedApproval;
    h.state.items[GATE] = gateRow([...LABELS, "gate:awaiting-console"]);
    h.state.condFail.push("gate:awaiting-console"); // already there → conditional add loses

    const res = await transition({ ticket_id: GATE, to_status: "done" });

    expect(res.reason).toBe("gate_condition_unmet");
    expect(h.state.statusUpdates).toHaveLength(0);
    expect(h.state.events, "the label add IS the dedupe").toHaveLength(0);
  });

  it("once the human answers, the same transition succeeds and is stamped", async () => {
    // The run's other half: after the approval, the pipeline reports no open gate.
    h.state.probeBy.Pipeline___get_state = { result: { waitingOn: null } };
    h.state.items[GATE] = gateRow([...LABELS, "gate:awaiting-console"]);

    const res = await transition({ ticket_id: GATE, to_status: "done" });

    expect(res.gateVerification).toMatchObject({ result: "verified", reason: "no_open_approval", gateKind: "deploy-approval" });
    expect(h.state.statusUpdates).toHaveLength(1);
    const w = h.state.statusUpdates[0];
    expect(w.ExpressionAttributeValues[":s"]).toBe("done");
    // The stamp and the parked label come off in the SAME write as the status.
    expect(w.UpdateExpression).toContain("#gv");
    expect(w.ExpressionAttributeValues[":stampl"]).toBe("gateverify:verified");
  });
});

describe("replay 37ule1 / TEAM-4650 — ci-unavailable with no build for eb71dbb", () => {
  const GATE = "TEAM-4650";
  const PIPELINE = "hub-agentcore-hub-deploy";
  const HEAD = "eb71dbb9c4a1f0e26d3b8a57fc90e14d2b6c7a83";

  beforeEach(() => {
    h.state.items[GATE] = {
      ticketId: GATE,
      status: "in_review",
      assignee: "agentcore_hub_ci_agent",
      labels: ["gate:ci-unavailable", `pipeline:${PIPELINE}`, `head:${HEAD}`],
      workflowId: "37ule1",
      parentId: "TEAM-4640",
      description: "CodeBuild never reported for this commit; treating CI as unavailable.",
    };
    // CI has a build history for the project — just not for this SHA. That is the
    // definite negative: the build was never started.
    h.state.probeBy.Pipeline___get_build_status = { result: { project: "hub-agentcore-hub-ci", match: null, scanned: 15 } };
  });

  it("refuses, and files NO CI re-certification ticket", async () => {
    const res = await transition({ ticket_id: GATE, to_status: "done" });

    expect(res).toMatchObject({ ok: false, reason: "gate_condition_unmet" });
    expect(res.hint).toContain(`NONE for commit ${HEAD}`);
    expect(res.hint, "the first remedy is to start the build").toContain(`Pipeline___start_ci_build(commit_sha="${HEAD}")`);
    expect(res.hint).toContain("Filing another CI ticket is NOT a remedy");
    expect(h.state.statusUpdates).toHaveLength(0);
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.probes[0]).toEqual({
      tool: "Pipeline___get_build_status",
      args: { pipeline_name: PIPELINE, commit_sha: HEAD },
    });
  });

  it("a DECISION line lifts the stall as ADVISORY — never as verified", async () => {
    h.state.items[GATE].description = "CodeBuild is down account-wide.\n\nDECISION: accept-proxy";

    const res = await transition({ ticket_id: GATE, to_status: "done" });

    expect(res.gateVerification).toMatchObject({ result: "indeterminate", reason: "decision_advisory", evidence: "accept-proxy" });
    expect(h.state.statusUpdates).toHaveLength(1);
  });

  it("a build that EXISTS disproves the claim whatever its verdict says", async () => {
    h.state.probeBy.Pipeline___get_build_status = {
      result: { project: "hub-agentcore-hub-ci", match: { buildId: "hub-agentcore-hub-ci:9f2", buildStatus: "FAILED" } },
    };

    const res = await transition({ ticket_id: GATE, to_status: "done" });

    expect(res.gateVerification).toMatchObject({ result: "verified", reason: "build_exists" });
    expect(res.gateVerification.evidence).toMatchObject({ buildStatus: "FAILED" });
  });
});

describe("replay 37ule1 — the same gate re-filed against the same target", () => {
  const EPIC = "TEAM-4640";
  const HEAD = "eb71dbb9c4a1f0e26d3b8a57fc90e14d2b6c7a83";
  const BLOCKED_BY = ["TEAM-4645"];
  // Normalized spelling, which is what the row actually holds: `sanitizeUserLabels`
  // rewrites `gate:ci-unavailable` → `gate-ci-unavailable`, and every reader is
  // `/^gate[:-]…$/` for exactly that reason.
  const prior = (id) => ({
    ticketId: id,
    labels: ["gate-ci-unavailable", `head-${HEAD}`],
    blockedBy: BLOCKED_BY,
  });
  const refile = () => create({
    summary: "CI is unavailable for the release commit",
    assignee: "agentcore_hub_ci_agent",
    labels: ["gate:ci-unavailable", `pipeline:hub-agentcore-hub-deploy`, `head:${HEAD}`],
    blocked_by: BLOCKED_BY,
    parent_key: EPIC,
  });

  beforeEach(() => {
    h.state.items[EPIC] = { ticketId: EPIC, type: "epic", workflowId: "37ule1", labels: [] };
  });

  it("the attempt that trips the loop refuses and pages the run exactly once", async () => {
    // ONE of these already exists against the same kind + head + blocked_by, so the
    // one being filed now is the second — the loop (FR-2). The prior is still open
    // and still the ticket to work.
    h.state.siblings.push(prior("TEAM-4650"));

    const res = await refile();

    expect(res).toMatchObject({ ok: false, reason: "gate_loop_environmental", existingTicketId: "TEAM-4650" });
    expect(h.state.puts, "no second gate ticket").toHaveLength(0);
    expect(h.state.counter, "and no id burned").toBe(0);
    // The marker goes on the EPIC, and the conditional add is the event dedupe.
    expect(h.state.labelUpdates.map((u) => u.Key.ticketId)).toEqual([EPIC]);
    expect(h.state.labelUpdates[0].ExpressionAttributeValues[":label"]).toBe("gate:loop-broken");
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0].type).toBe("workflow.blocked");
    expect(h.state.events[0].detail).toMatchObject({
      reason: "environmental",
      gateKind: "ci-unavailable",
      head: HEAD,
      // The attempt being refused: one prior + this one.
      attempt: 2,
    });
    expect(h.state.events[0].workflowId, "run id off the EPIC row").toBe("37ule1");
  });

  it("the next attempt refuses identically and says nothing", async () => {
    h.state.siblings.push(prior("TEAM-4650"), prior("TEAM-4652"));
    h.state.items[EPIC].labels = ["gate:loop-broken"];
    h.state.condFail.push("gate:loop-broken"); // already marked → the add loses

    const res = await refile();

    expect(res).toMatchObject({ ok: false, reason: "gate_loop_environmental", existingTicketId: "TEAM-4650" });
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.events, "no second workflow.blocked").toHaveLength(0);
  });

  it("a DIFFERENT target under the same epic is not the same loop", async () => {
    const otherHead = "c".repeat(40);
    h.state.siblings.push({
      ticketId: "TEAM-4650",
      labels: ["gate-ci-unavailable", `head-${otherHead}`],
      blockedBy: ["TEAM-4699"],
    });

    const res = await refile();

    expect(res.ok).not.toBe(false);
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.events).toHaveLength(0);
  });
});

/**
 * replay TEAM-4986 — a serial CD follow-up is not the earlier gate's loop.
 *
 * Observed 2026-09-22 on wf_bug_TEAM-4798. The release manager filed the deploy
 * approval for its follow-up PR's pipeline execution and was refused
 * `gate_loop_environmental` against TEAM-4979 — a DONE deploy gate for a DIFFERENT
 * execution under the same Bug parent, from the previous follow-up. The epic was
 * labelled `gate:loop-broken`, a human was paged, and the run could not ship.
 *
 * `gateLoopVerdict` matched it on the gate KIND alone: a deploy gate carries no
 * `head:` and no `blocked_by`, so the `untargeted` arm made every earlier
 * deploy-approval sibling a prior regardless of execution or status. The fixture is
 * the real one — the two execution ids, the real labels, the real parent.
 */
describe("replay TEAM-4986 — a serial CD follow-up is not the earlier gate's loop", () => {
  const EPIC = "TEAM-4798";
  const PIPELINE = "hub-juno-deploy";
  // The DONE gate from the earlier follow-up, and the execution being approved now.
  const EXEC_DONE = "c33ac06f-b684-4d0a-b486-d8f812020022";
  const EXEC_NEW = "7bb31573-3917-49aa-898e-c132c9bc5ad6";
  const CONSOLE = `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE}/view?region=us-east-1`;

  /** TEAM-4979 as the row actually held it (normalized label spelling). */
  const prior = (status) => ({
    ticketId: "TEAM-4979",
    status,
    labels: ["gate-approval", "gate-deploy-approval", `pipeline-${PIPELINE}`, `exec-${EXEC_DONE}`],
  });
  /** The refused create, exactly as the release manager issued it. */
  const fileGate = (exec) => create({
    summary: "Deploy Approval: production deploy for the review-fix follow-up",
    assignee: "human:engineer",
    labels: ["gate:approval", "gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${exec}`],
    description: `Approve the production deploy for the ${EPIC} follow-up PR.\n\nConsole: ${CONSOLE}`,
    parent_key: EPIC,
  });

  beforeEach(() => {
    h.state.items[EPIC] = { ticketId: EPIC, type: "bug", workflowId: "wf_bug_TEAM-4798", labels: [] };
    // The pipeline is registered and cannot self-approve — the shape seam's happy
    // path, so the loop seam is provably what decides each row below.
    h.state.probeBy.Pipeline___capabilities = { result: { ok: true, approveDeploy: false } };
  });

  it("the refused gate is CREATED — no marker on the epic, and nobody paged", async () => {
    h.state.siblings.push(prior("done"));

    const res = await fileGate(EXEC_NEW);

    expect(res.ok).not.toBe(false);
    expect(h.state.puts, "the gate the human was waiting for").toHaveLength(1);
    expect(h.state.puts[0].labels).toContain(`exec-${EXEC_NEW}`);
    expect(h.state.counter, "one id minted").toBe(1);
    expect(
      h.state.labelUpdates.map((u) => u.ExpressionAttributeValues[":label"]),
      "the epic is never labelled gate:loop-broken"
    ).toEqual([]);
    expect(h.state.events, "and no workflow.blocked page").toHaveLength(0);
  });

  it("an OPEN gate for the SAME execution is still the loop", async () => {
    // The guard keeps working: a genuine re-file of the same deploy decision.
    h.state.siblings.push(prior("in_review"));

    const res = await fileGate(EXEC_DONE);

    expect(res).toMatchObject({ ok: false, reason: "gate_loop_environmental", existingTicketId: "TEAM-4979" });
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter).toBe(0);
    expect(h.state.labelUpdates[0].ExpressionAttributeValues[":label"]).toBe("gate:loop-broken");
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0].type).toBe("workflow.blocked");
    expect(h.state.events[0].detail).toMatchObject({
      reason: "environmental",
      gateKind: "deploy-approval",
      blockedByTicketId: "TEAM-4979",
      exec: EXEC_DONE,
      attempt: 2,
    });
    expect(h.state.events[0].workflowId, "run id off the EPIC row").toBe("wf_bug_TEAM-4798");
  });

  it("a DONE gate for the same execution is answered, not looping", async () => {
    // The pipeline re-ran the same execution after the first approval expired: the
    // answered gate cannot be the ticket to work, so a new one must be filable.
    h.state.siblings.push(prior("done"));

    const res = await fileGate(EXEC_DONE);

    expect(res.ok).not.toBe(false);
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.events).toHaveLength(0);
  });
});

/**
 * replay TEAM-4758 (TEAM-4764 P1) — the unbound ci-unavailable gate.
 *
 * QA filed a `gate:ci-unavailable` ticket carrying `head:<sha>` and NO `pipeline:`
 * label. `gatePipelineOf` returned null, so `verifyGateCondition`'s ci arm took its
 * `indeterminate`/`gate_unbound` exit and the close was admitted without a single
 * read — the guard was inert. A 41-character `head:` value disarms it identically,
 * since HEAD_LABEL_RE is anchored at 40 hex.
 *
 * The fix is create-time, and the reason is the fail direction: the close guard
 * refuses only on a definite negative, so a gate that cannot be probed MUST be
 * admitted there. At create time the agent has both bindings in hand, so demanding
 * them is cheap; refusing before `nextTicketId` also means no id is burned.
 */
describe("create_ticket — an unbound ci-unavailable gate is refused at create time (TEAM-4758)", () => {
  const EPIC = "TEAM-4750";
  const PIPELINE = "hub-agentcore-hub-deploy";
  const HEAD = "a".repeat(40);

  const file = (labels) => create({
    summary: "CI is unavailable for the release commit",
    assignee: "agentcore_hub_ci_agent",
    labels,
    parent_key: EPIC,
  });

  beforeEach(() => {
    h.state.items[EPIC] = { ticketId: EPIC, type: "epic", workflowId: "ab12cd", labels: [] };
  });

  it("(a) refuses a head-only gate — no pipeline to probe, no id minted", async () => {
    const res = await file(["gate:ci-unavailable", `head:${HEAD}`]);

    expect(res).toMatchObject({ ok: false, reason: "gate_condition_unmet" });
    expect(res.hint).toBe(
      "a ci-unavailable gate must carry exactly one `pipeline:<name>` label (found 0) — " +
        "without it the close guard has nothing to probe and admits the gate unproven (indeterminate/gate_unbound)"
    );
    expect(h.state.puts, "no gate ticket row").toHaveLength(0);
    expect(h.state.counter, "and no id burned").toBe(0);
    expect(h.state.probes, "the label half needs no read at all").toHaveLength(0);
  });

  it("(b) refuses a 41-hex head — the value that silently disarmed the guard", async () => {
    const res = await file(["gate:ci-unavailable", `pipeline:${PIPELINE}`, `head:${"a".repeat(41)}`]);

    expect(res).toMatchObject({ ok: false, reason: "gate_condition_unmet" });
    expect(res.hint).toBe(
      "a ci-unavailable gate must carry exactly one `head:<sha>` label whose value is exactly 40 hex chars " +
        "(found 1) — without it the close guard has nothing to probe and admits the gate " +
        "unproven (indeterminate/gate_unbound)"
    );
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter).toBe(0);
  });

  it("(c) refuses two head: labels — which commit would the probe ask about?", async () => {
    const res = await file([
      "gate:ci-unavailable",
      `pipeline:${PIPELINE}`,
      `head:${HEAD}`,
      `head:${"c".repeat(40)}`,
    ]);

    expect(res).toMatchObject({ ok: false, reason: "gate_condition_unmet" });
    expect(res.hint).toContain("(found 2)");
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter).toBe(0);
  });

  it("(d) creates a gate bound to one pipeline and one 40-hex head", async () => {
    const res = await file(["gate:ci-unavailable", `pipeline:${PIPELINE}`, `head:${HEAD}`]);

    expect(res.ok).not.toBe(false);
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.counter, "one id minted").toBe(1);
    expect(h.state.probes, "a ci gate claims CI is down — probing it proves nothing").toHaveLength(0);
  });

  it("(e) leaves a plain ticket and a gate:approval ticket alone", async () => {
    const plain = await file(["needs-docs"]);
    expect(plain.ok).not.toBe(false);

    const approval = await create({
      summary: "A human must decide whether to ship without the e2e suite",
      assignee: "human:tycen",
      labels: ["gate:approval"],
      parent_key: EPIC,
    });
    expect(approval.ok).not.toBe(false);

    expect(h.state.puts).toHaveLength(2);
    expect(h.state.probes, "neither kind is shape-checked or probed").toHaveLength(0);
  });
});
