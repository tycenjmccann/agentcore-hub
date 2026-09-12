/**
 * performance/index.json access — the fleet-wide roll-up of per-run performance
 * cards that the cost-report Lambda maintains in the artifact bucket.
 *
 * Lifted out of src/app/api/workflow/performance/route.ts so the performance
 * route and the list route (which joins each run's hero KPI onto its row) share
 * ONE module-level cache and therefore one S3 GET per TTL, instead of a GET per
 * route per request.
 *
 * Read-only: nothing here writes S3 or DynamoDB, and it imports no UI code.
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { ARTIFACT_BUCKET } from "@/lib/workflow/agent-setup";
import type { PerformanceIndex } from "@/lib/workflow/performance";

const REGION = process.env.AWS_REGION || "us-east-1";
const INDEX_KEY = process.env.PERFORMANCE_INDEX_KEY || "performance/index.json";

export const INDEX_TTL_MS = 60_000;

const s3 = new S3Client({ region: REGION });
let indexCache: { at: number; value: PerformanceIndex } | null = null;

/** Parsed JSON at `key`, or null when the object doesn't exist. Other errors throw. */
export async function getJson<T>(key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    return JSON.parse(await res.Body!.transformToString()) as T;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

/** The index, memoized for INDEX_TTL_MS. A missing / malformed index reads as empty. */
export async function loadIndex(): Promise<PerformanceIndex> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.value;
  const idx = await getJson<PerformanceIndex>(INDEX_KEY);
  const value: PerformanceIndex = idx && Array.isArray(idx.cards) ? idx : { version: 1, updatedAt: null, cards: [], infra: null };
  indexCache = { at: Date.now(), value };
  return value;
}

/** Test-only: drop the memoized index so a spec can control what the next load sees. */
export function resetIndexCache(): void {
  indexCache = null;
}
