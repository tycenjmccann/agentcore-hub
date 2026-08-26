/**
 * Intake Processing
 *
 * Handles multi-source input for workflow initiation:
 * - URL: Fetch webpage content, extract text/images
 * - Upload: Process uploaded files (PDF→text, images→base64)
 * - S3: Read objects from user-specified S3 location
 *
 * Processed content is packaged for the requirements agent.
 */

import {
  S3Client,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { IntakeSource } from "./types";

const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";

interface ProcessedSource {
  type: IntakeSource["type"];
  originalValue: string;
  content: string;
  contentType: string;
  label?: string;
  s3Key?: string; // Where it was stored in the workflow bucket
  isImage?: boolean; // True if this is an image (content is base64)
  imageFormat?: string; // png, jpeg, gif, webp
  isBinary?: boolean; // True if binary non-image (PDF, etc.)
}

// ─── Upfront Validation ─────────────────────────────────────────────────────

/**
 * Validate that all intake sources are reachable BEFORE starting the workflow.
 * Returns an array of error strings for any unreachable sources.
 * Empty array = all sources valid.
 */
export async function validateIntakeSources(
  sources: IntakeSource[]
): Promise<string[]> {
  const errors: string[] = [];
  const client = new S3Client({ region: DEFAULT_REGION });

  const checks = sources.map(async (source) => {
    const value = source.value;
    try {
      if (value.startsWith("s3://")) {
        // S3 URI — validate format, skip HEAD for our own artifact bucket
        // (App Runner may not have S3 read permissions, but agents do at runtime)
        const match = value.match(/^s3:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          return `Invalid S3 URI format: ${value}`;
        }
        const [, bucket, key] = match;
        const ownBucket = process.env.ARTIFACT_BUCKET || process.env.AGENTCORE_HUB_ARTIFACT_BUCKET || "";
        if (bucket === ownBucket) {
          return null; // Trust internal references — agent can read at runtime
        }
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return null; // OK
      } else if (value.startsWith("http://") || value.startsWith("https://")) {
        // Trust GitHub URLs under the configured owner (SI loop references)
        const trustedOwner = process.env.GITHUB_OWNER;
        if (trustedOwner && value.includes(`github.com/${trustedOwner}/`)) {
          return null;
        }
        // HTTP URL — HEAD check
        const res = await fetch(value, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          return `URL unreachable (${res.status}): ${value}`;
        }
        return null; // OK
      }
      // Upload type — skip validation (already in memory)
      return null;
    } catch (err) {
      return `Source unreachable: ${value} — ${(err as Error).message}`;
    }
  });

  const results = await Promise.allSettled(checks);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      errors.push(result.value);
    } else if (result.status === "rejected") {
      errors.push(`Validation error: ${result.reason}`);
    }
  }

  return errors;
}
