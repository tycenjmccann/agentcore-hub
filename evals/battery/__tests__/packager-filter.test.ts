// TEAM-3090 defense-in-depth: the eval-packager Lambda must skip any record
// whose session id carries the battery prefix — battery runs emit nothing by
// design (direct Converse, no OTEL), this is belt-and-suspenders. The module
// requires ARTIFACTS_BUCKET at import time, so set a synthetic one first; no
// AWS client is ever exercised (isBatterySession is pure).
//
// TEAM-3390 extends this with behavioral coverage of BOTH ingestion paths:
// extractSessionData (batch buffering) and aggregateScoresToDdb (dashboard
// score aggregates). The DynamoDB Document client is mocked (vi.mock on
// @aws-sdk/lib-dynamodb) so aggregateScoresToDdb runs hermetically and we can
// assert on the exact UpdateCommand it writes.
//
// TEAM-3427 adds handler-level coverage: (finding 5) an all-battery CloudWatch
// Logs delivery must produce ZERO DynamoDB calls of any kind — not even the
// agent-config GetCommand — while parse-error-only deliveries still buffer;
// (finding 6) the aggregation guard must catch battery ids in the legacy
// top-level shape. The S3 client is also mocked so the REAL handler can run
// end-to-end on a gzipped CW Logs payload.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BATTERY_TENANT } from "../lib/agent-runner.mjs";

// vi.mock factories are hoisted above imports; vi.hoisted keeps the capture
// state reachable from the factory.
const ddbMock = vi.hoisted(() => ({
  sent: [] as any[],
}));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: any) {}
  }
  class UpdateCommand {
    constructor(public input: any) {}
  }
  const send = async (cmd: any) => {
    ddbMock.sent.push(cmd);
    if (cmd instanceof GetCommand) {
      // Scorecard read (has a ProjectionExpression): blank Item, so
      // aggregateScoresToDdb merges deltas into an empty scorecard.
      if (cmd.input.ProjectionExpression) return { Item: undefined };
      // Agent-config read: enabled, never sampled out, so the handler
      // proceeds past the config/enabled/sample checks.
      return {
        Item: { agentId: cmd.input.Key.agentId, enabled: true, sampleRate: 100, batchSize: 10 },
      };
    }
    // appendToBuffer's UpdateCommand asks for ALL_NEW: echo back the appended
    // envelope(s) as the whole buffer (empty-table semantics — never flushes).
    if (cmd instanceof UpdateCommand && cmd.input.ReturnValues === "ALL_NEW") {
      return {
        Attributes: {
          sessionBuffer: cmd.input.ExpressionAttributeValues[":new"] ?? [],
          bufferSessions: cmd.input.ExpressionAttributeValues[":sids"],
        },
      };
    }
    return {};
  };
  return {
    GetCommand,
    UpdateCommand,
    DynamoDBDocumentClient: { from: () => ({ send }) },
  };
});

// TEAM-3427: mock S3 so the real handler can load agents.json hermetically.
// evalConfigName matches the log groups used throughout this file.
vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    constructor(public input: any) {}
  }
  class PutObjectCommand {
    constructor(public input: any) {}
  }
  const send = async () => ({
    Body: {
      transformToString: async () =>
        JSON.stringify({ agents: [{ agentId: "test-agent", evalConfigName: "eval_test-agent" }] }),
    },
  });
  return {
    GetObjectCommand,
    PutObjectCommand,
    S3Client: class {
      send = send;
    },
  };
});

process.env.ARTIFACTS_BUCKET ||= "unit-test-bucket";
const { isBatterySession, extractSessionData, aggregateScoresToDdb, handler } =
  await import("../../../lambda/eval-packager/index.mjs");

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Wrap a parsed CW Logs payload into the awslogs event shape Lambda receives. */
function awslogsEvent(payload: object) {
  return {
    awslogs: {
      data: gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64"),
    },
  };
}

/** Log event shaped like a real OTEL eval record delivered via CW Logs. */
function otelLogEvent(sessionId: string, evaluator: string, score: number, timestamp = 1724800000000) {
  return {
    timestamp,
    message: JSON.stringify({
      attributes: {
        "session.id": sessionId,
        "gen_ai.evaluation.name": evaluator,
        "gen_ai.evaluation.score.value": score,
      },
    }),
  };
}

/**
 * Legacy/top-level shape: session.id at the top of the parsed message while
 * the evaluator fields still live in attributes. extractSessionData has always
 * supported this via its `attrs['session.id'] || parsedMessage['session.id']`
 * fallback; TEAM-3427 finding 6 is that aggregateScoresToDdb did not.
 */
function topLevelLogEvent(sessionId: string, evaluator: string, score: number, timestamp = 1724800000000) {
  return {
    timestamp,
    message: JSON.stringify({
      "session.id": sessionId,
      attributes: {
        "gen_ai.evaluation.name": evaluator,
        "gen_ai.evaluation.score.value": score,
      },
    }),
  };
}

describe("eval-packager battery guard (TEAM-3090)", () => {
  it("recognizes battery-prefixed session ids and nothing else", () => {
    expect(isBatterySession("battery-abc123-triage-crash-chain-001")).toBe(true);
    expect(isBatterySession(`${BATTERY_TENANT}-anything`)).toBe(true); // tenant shares the prefix
    expect(isBatterySession("prod-run-42")).toBe(false);
    expect(isBatterySession("my-battery-session")).toBe(false); // prefix, not substring
    expect(isBatterySession(null)).toBe(false);
    expect(isBatterySession(undefined)).toBe(false);
    expect(isBatterySession(42 as any)).toBe(false);
  });

  it("guards extractSessionData before any buffering (source-level wiring check)", () => {
    const src = readFileSync(join(REPO_ROOT, "lambda/eval-packager/index.mjs"), "utf8");
    // the skip must run before the sid is counted toward the batch
    const guardAt = src.indexOf("if (isBatterySession(sid))");
    const countAt = src.indexOf("sessionIds.add(sid)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(countAt);
  });
});

describe("eval-packager battery guard — behavioral, both paths (TEAM-3390)", () => {
  const mixedBatch = {
    logGroup: "/aws/bedrock-agentcore/evaluations/results/eval_test-agent-abc",
    logStream: "stream-1",
    logEvents: [
      otelLogEvent("battery-run1-case1", "helpfulness", 0.2),
      otelLogEvent("prod-run-42", "helpfulness", 0.9),
      otelLogEvent("battery-run1-case2", "correctness", 0.1),
      otelLogEvent("prod-run-43", "correctness", 0.8),
    ],
  };

  it("extractSessionData drops battery sessions and keeps non-battery ones", () => {
    const data = extractSessionData(mixedBatch);

    expect(data.sessionIds).toEqual(["prod-run-42", "prod-run-43"]);
    expect(data.sessionIds.some((sid: string) => sid.startsWith("battery-"))).toBe(false);

    expect(data.evaluatorResults).toHaveLength(2);
    expect(data.evaluatorResults.map((r: any) => r.sessionId)).toEqual([
      "prod-run-42",
      "prod-run-43",
    ]);
    expect(data.evaluatorResults.map((r: any) => r.score)).toEqual([0.9, 0.8]);
  });

  it("aggregateScoresToDdb excludes battery sessions from session count and score deltas", async () => {
    ddbMock.sent.length = 0;
    await aggregateScoresToDdb("test-agent", mixedBatch);

    const update = ddbMock.sent.find((cmd) => cmd.constructor.name === "UpdateCommand");
    expect(update).toBeDefined();

    const values = update.input.ExpressionAttributeValues;
    // Session count: only the 2 non-battery sessions (battery ids never enter
    // the set, so they can't inflate the dashboard's per-agent stats).
    expect(values[":sc"]).toBe(2);
    // Score aggregates: only non-battery contributions. If battery events
    // leaked in, helpfulness would be {sum: 1.1, count: 2} etc.
    expect(values[":scores"]).toEqual({
      helpfulness: { sum: 0.9, count: 1 },
      correctness: { sum: 0.8, count: 1 },
    });
  });

  it("aggregateScoresToDdb writes nothing at all for a battery-only batch", async () => {
    ddbMock.sent.length = 0;
    await aggregateScoresToDdb("test-agent", {
      logGroup: "/aws/bedrock-agentcore/evaluations/results/eval_test-agent-abc",
      logStream: "stream-1",
      logEvents: [
        otelLogEvent("battery-run1-case1", "helpfulness", 0.2),
        otelLogEvent("battery-run1-case2", "correctness", 0.1),
      ],
    });

    expect(ddbMock.sent).toHaveLength(0);
  });
});

describe("empty battery envelope is never buffered (TEAM-3427 finding 5, NFR-1.3)", () => {
  const allBatteryBatch = {
    logGroup: "/aws/bedrock-agentcore/evaluations/results/eval_test-agent-abc",
    logStream: "stream-1",
    logEvents: [
      otelLogEvent("battery-run1-case1", "helpfulness", 0.2),
      otelLogEvent("battery-run1-case2", "correctness", 0.1),
    ],
  };

  it("extractSessionData retains nothing for an all-battery batch", () => {
    const data = extractSessionData(allBatteryBatch);
    expect(data.sessionIds).toEqual([]);
    expect(data.evaluatorResults).toEqual([]);
  });

  it("handler gates appendToBuffer on the retained-empty condition (source-level wiring check)", () => {
    const src = readFileSync(join(REPO_ROOT, "lambda/eval-packager/index.mjs"), "utf8");
    const extractAt = src.indexOf("const sessionData = extractSessionData(parsed)");
    const guardAt = src.indexOf(
      "sessionData.evaluatorResults.length === 0 && sessionData.sessionIds.length === 0"
    );
    const appendAt = src.indexOf("appendToBuffer(agentId, sessionData");
    expect(extractAt).toBeGreaterThan(-1);
    // early-return guard sits between extraction and the buffer write
    expect(guardAt).toBeGreaterThan(extractAt);
    expect(appendAt).toBeGreaterThan(guardAt);
  });

  it("real handler: an all-battery CW Logs delivery produces ZERO DynamoDB calls of any kind", async () => {
    ddbMock.sent.length = 0;
    const result = await handler(awslogsEvent(allBatteryBatch));

    expect(result).toEqual({ statusCode: 200, body: "battery-filtered" });
    // Extraction runs BEFORE the agent-config read, so an all-battery delivery
    // issues no reads and no writes — not even the config GetCommand.
    expect(ddbMock.sent).toHaveLength(0);
  });

  it("real handler: a mixed batch still reads config and buffers only the non-battery run", async () => {
    ddbMock.sent.length = 0;
    await handler(
      awslogsEvent({
        logGroup: "/aws/bedrock-agentcore/evaluations/results/eval_test-agent-abc",
        logStream: "stream-1",
        logEvents: [
          otelLogEvent("battery-run1-case1", "helpfulness", 0.2),
          otelLogEvent("prod-run-42", "helpfulness", 0.9),
        ],
      })
    );

    // Normal path is intact: config GetCommand + aggregation + buffer append.
    const sentNames = ddbMock.sent.map((cmd) => cmd.constructor.name);
    expect(sentNames).toContain("GetCommand");
    const append = ddbMock.sent.find(
      (cmd) =>
        cmd.constructor.name === "UpdateCommand" &&
        cmd.input.UpdateExpression?.includes("sessionBuffer")
    );
    expect(append).toBeDefined();
    // The appended envelope carries only the non-battery run.
    const envelope = append.input.ExpressionAttributeValues[":new"][0];
    expect(envelope.sessionIds).toEqual(["prod-run-42"]);
  });

  it("still buffers a delivery that only carries parse-error records", async () => {
    // The early return must trigger ONLY when nothing was retained: parse-error
    // records land in evaluatorResults (no sessionIds) and must buffer as before.
    ddbMock.sent.length = 0;
    const result = await handler(
      awslogsEvent({
        logGroup: "/aws/bedrock-agentcore/evaluations/results/eval_test-agent-abc",
        logStream: "stream-1",
        logEvents: [{ timestamp: 1724800000000, message: "not-json {" }],
      })
    );

    expect(result).toEqual({ statusCode: 200, body: "ok" });
    const writes = ddbMock.sent.filter((cmd) => cmd.constructor.name === "UpdateCommand");
    // exactly the buffer append (aggregation no-ops: no sessions, no scores)
    expect(writes).toHaveLength(1);
    expect(writes[0].input.UpdateExpression).toContain("sessionBuffer = list_append");
    expect(writes[0].input.ExpressionAttributeValues[":new"][0].evaluatorResults[0].parseError).toBe(true);
  });
});

describe("top-level session.id hits the aggregation battery guard (TEAM-3427 finding 6)", () => {
  const logGroup = "/aws/bedrock-agentcore/evaluations/results/eval_test-agent-abc";

  it("excludes a battery record in the legacy top-level shape from score aggregates", async () => {
    // Pre-fix, aggregateScoresToDdb resolved the session id ONLY from
    // attributes['session.id'], so this battery record resolved to '' →
    // bypassed isBatterySession and its 0.05 score polluted helpfulness
    // ({sum: 0.95, count: 2}). This test FAILS against that code.
    ddbMock.sent.length = 0;
    await aggregateScoresToDdb("test-agent", {
      logGroup,
      logStream: "stream-1",
      logEvents: [
        topLevelLogEvent("battery-run9-case1", "helpfulness", 0.05),
        otelLogEvent("prod-run-42", "helpfulness", 0.9),
        otelLogEvent("prod-run-43", "correctness", 0.8),
      ],
    });

    const update = ddbMock.sent.find((cmd) => cmd.constructor.name === "UpdateCommand");
    expect(update).toBeDefined();
    const values = update.input.ExpressionAttributeValues;
    expect(values[":sc"]).toBe(2);
    expect(values[":scores"]).toEqual({
      helpfulness: { sum: 0.9, count: 1 },
      correctness: { sum: 0.8, count: 1 },
    });
  });

  it("counts a non-battery top-level session id toward the session set (matches extraction)", async () => {
    ddbMock.sent.length = 0;
    await aggregateScoresToDdb("test-agent", {
      logGroup,
      logStream: "stream-1",
      logEvents: [
        topLevelLogEvent("prod-run-77", "helpfulness", 0.5),
        otelLogEvent("prod-run-42", "helpfulness", 0.75),
      ],
    });

    const update = ddbMock.sent.find((cmd) => cmd.constructor.name === "UpdateCommand");
    expect(update).toBeDefined();
    const values = update.input.ExpressionAttributeValues;
    // both shapes count: prod-run-77 (top-level) + prod-run-42 (attributes)
    expect(values[":sc"]).toBe(2);
    expect(values[":scores"]).toEqual({ helpfulness: { sum: 1.25, count: 2 } });
  });
});
