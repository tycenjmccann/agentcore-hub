/**
 * Query helpers over agentcore-hub-eval-results — one row per evaluator verdict.
 *
 * The daily table (src/lib/eval-metrics.ts) answers "how did this agent trend";
 * this table answers "what exactly did the judge say about THIS session". Shape
 * is fixed by the deploy unit and mirrored here:
 *
 *   PK  agentId (S)
 *   SK  sk (S) = `${evaluatedAt ISO}#${dedupKey}`   → newest-first is a plain
 *                                                     descending range scan
 *   GSI bySession   gsi1pk = sessionId          / gsi1sk = `${evaluator}#${evaluatedAt}`
 *   GSI byPersona   gsi2pk = `${agentId}#${persona}` / sk
 *   GSI byWorkflow  gsi3pk = workflowId        / sk
 *
 * All three projections are ALL, so every read below is a single Query with no
 * follow-up fetch. Because the sort key LEADS with the ISO timestamp, a UTC day
 * range (`from`/`to`, inclusive) is expressible as a key condition — the filter
 * costs no extra read capacity and never scans outside the window.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.EVAL_RESULTS_TABLE || "agentcore-hub-eval-results";

export const INDEX_BY_SESSION = "bySession";
export const INDEX_BY_PERSONA = "byPersona";
export const INDEX_BY_WORKFLOW = "byWorkflow";

export const DEFAULT_RESULTS_LIMIT = 50;
export const MAX_RESULTS_LIMIT = 200;

/** U+FFFF: sorts after every character a `YYYY-MM-DDT…` sort key can contain. */
const DAY_UPPER_BOUND = "￿";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

/** One evaluator verdict. Only the key/join fields are guaranteed present. */
export interface EvalResultRow {
  agentId: string;
  sk: string;
  sessionId: string;
  evaluator: string;
  evaluatedAt: string;
  persona?: string;
  workflowId?: string;
  ticketId?: string;
  score?: number | null;
  scoreLabel?: string;
  explanation?: string;
  explanationTruncated?: boolean;
  errorType?: string;
  errorMessage?: string;
  status?: string;
  statusReason?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  logGroup?: string;
  day?: string;
  ingestedAt?: string;
  source?: string;
}

export interface QueryResultsOptions {
  agentId?: string | null;
  persona?: string | null;
  workflowId?: string | null;
  /** Inclusive UTC day key, `YYYY-MM-DD`. */
  from?: string | null;
  /** Inclusive UTC day key, `YYYY-MM-DD`. */
  to?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface QueryResultsPage {
  items: EvalResultRow[];
  /** Opaque next-page token, or null when this was the last page. */
  cursor: string | null;
  /** Which access pattern served the page — null means the base table. */
  index: string | null;
}

export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(v: unknown): v is string {
  return typeof v === "string" && DAY_KEY_RE.test(v);
}

/** base64url of the raw LastEvaluatedKey. null when there is no next page. */
export function encodeCursor(key: Record<string, unknown> | null | undefined): string | null {
  if (!key || Object.keys(key).length === 0) return null;
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * Inverse of encodeCursor. Returns undefined — never throws — for anything that
 * isn't a flat scalar object, so a hand-edited `?cursor=` in the URL bar
 * degrades to "first page" instead of a 500.
 */
export function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed as Record<string, unknown>);
  // A LastEvaluatedKey is at most a table PK/SK plus an index PK/SK, all scalars.
  if (entries.length === 0 || entries.length > 4) return undefined;
  for (const [, v] of entries) {
    if (typeof v !== "string" && typeof v !== "number") return undefined;
  }
  return Object.fromEntries(entries);
}

function clampLimit(limit: number | null | undefined): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESULTS_LIMIT;
  return Math.min(MAX_RESULTS_LIMIT, Math.floor(n));
}

/** Key condition + values for the `sk` day range, appended to the PK equality. */
function skRange(from?: string | null, to?: string | null): { expr: string; values: Record<string, string> } {
  const lo = isDayKey(from) ? from : null;
  const hi = isDayKey(to) ? to : null;
  if (lo && hi && lo === hi) return { expr: " AND begins_with(#sk, :day)", values: { ":day": lo } };
  if (lo && hi) return { expr: " AND #sk BETWEEN :from AND :to", values: { ":from": lo, ":to": hi + DAY_UPPER_BOUND } };
  if (lo) return { expr: " AND #sk >= :from", values: { ":from": lo } };
  if (hi) return { expr: " AND #sk <= :to", values: { ":to": hi + DAY_UPPER_BOUND } };
  return { expr: "", values: {} };
}

/**
 * The Query input for one results page. Pure — exported so the index choice is
 * assertable without a client.
 *
 * Index precedence: workflowId (the narrowest question — one run) beats
 * persona, which beats the plain per-agent partition.
 */
export function buildResultsQuery(opts: QueryResultsOptions) {
  const workflowId = opts.workflowId || null;
  const agentId = opts.agentId || null;
  const persona = opts.persona || null;

  let index: string | null = null;
  let pkName: string;
  let pkValue: string;

  if (workflowId) {
    index = INDEX_BY_WORKFLOW;
    pkName = "gsi3pk";
    pkValue = workflowId;
  } else if (agentId && persona) {
    index = INDEX_BY_PERSONA;
    pkName = "gsi2pk";
    pkValue = `${agentId}#${persona}`;
  } else if (agentId) {
    pkName = "agentId";
    pkValue = agentId;
  } else {
    throw new Error("queryResults requires agentId or workflowId");
  }

  const range = skRange(opts.from, opts.to);

  return {
    index,
    input: {
      TableName: TABLE,
      ...(index ? { IndexName: index } : {}),
      KeyConditionExpression: `#pk = :pk${range.expr}`,
      ExpressionAttributeNames: { "#pk": pkName, ...(range.expr ? { "#sk": "sk" } : {}) },
      ExpressionAttributeValues: { ":pk": pkValue, ...range.values },
      // Newest verdict first — the operator always wants the latest failure.
      ScanIndexForward: false,
      Limit: clampLimit(opts.limit),
      ExclusiveStartKey: decodeCursor(opts.cursor),
    },
  };
}

/** One page of verdicts, newest first. */
export async function queryResults(opts: QueryResultsOptions): Promise<QueryResultsPage> {
  const { index, input } = buildResultsQuery(opts);
  const res = await ddb.send(new QueryCommand(input));
  return {
    items: (res.Items || []) as EvalResultRow[],
    cursor: encodeCursor(res.LastEvaluatedKey),
    index,
  };
}

/**
 * Every verdict recorded for one session, oldest evaluator first. This is the
 * authoritative per-session view: unlike queryResults (which pages the whole
 * partition and can split a session across pages) it always returns the
 * complete set, following pagination internally. A session holds one row per
 * evaluator — bounded by the evaluator roster, not by traffic.
 */
export async function queryBySession(sessionId: string): Promise<EvalResultRow[]> {
  const items: EvalResultRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: INDEX_BY_SESSION,
      KeyConditionExpression: "#pk = :sid",
      ExpressionAttributeNames: { "#pk": "gsi1pk" },
      ExpressionAttributeValues: { ":sid": sessionId },
      ScanIndexForward: true,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...((res.Items || []) as EvalResultRow[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}
