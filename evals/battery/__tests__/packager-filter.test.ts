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
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
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
    // Empty scorecard: aggregateScoresToDdb merges deltas into a blank Item.
    if (cmd instanceof GetCommand) return { Item: undefined };
    return {};
  };
  return {
    GetCommand,
    UpdateCommand,
    DynamoDBDocumentClient: { from: () => ({ send }) },
  };
});

process.env.ARTIFACTS_BUCKET ||= "unit-test-bucket";
const { isBatterySession, extractSessionData, aggregateScoresToDdb } =
  await import("../../../lambda/eval-packager/index.mjs");

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

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
