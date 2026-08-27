/**
 * PRD Submitter Lambda
 *
 * Trigger: S3 PutObject on fleet-imp-agent/prd/ prefix (via EventBridge)
 *
 * Reads the PRD the fleet improver agent wrote to S3, submits to workflow API.
 *
 * Environment:
 *   ARTIFACT_BUCKET - S3 bucket
 *   WORKFLOW_API_URL - App Runner workflow API base URL
 *   FLEET_REPO_URL - Git repo URL for the agent fleet
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const BUCKET = process.env.ARTIFACT_BUCKET;
const WORKFLOW_API = process.env.WORKFLOW_API_URL;
const FLEET_REPO = process.env.FLEET_REPO_URL;

if (!BUCKET) throw new Error("ARTIFACT_BUCKET env var required");
if (!WORKFLOW_API) throw new Error("WORKFLOW_API_URL env var required");
if (!FLEET_REPO) throw new Error("FLEET_REPO_URL env var required");

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

export async function handler(event) {
  const key = event.detail?.object?.key || event.key;
  if (!key || !key.endsWith(".json")) return { statusCode: 200, body: "Skipped" };

  console.log(`[prd-submitter] ${key}`);

  // Read PRD from S3
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const prd = JSON.parse(await result.Body.transformToString());

  // Only synthesized PRDs ({title, description}) may start a workflow. Raw eval
  // batches (or anything else) landing on the prd/ prefix would interpolate as
  // "[SI] undefined" and burn a full pipeline run on an empty request.
  if (!prd.title || typeof prd.title !== "string" || !prd.description || typeof prd.description !== "string") {
    console.error(`[prd-submitter] REJECTED ${key}: missing title/description — not a synthesized PRD (keys: ${Object.keys(prd).join(", ")})`);
    return { statusCode: 200, body: "Rejected: not a synthesized PRD" };
  }

  // Submit to workflow API
  const payload = {
    title: `[SI] ${prd.title}`,
    description: prd.description,
    repoConfig: {
      layout: "monorepo",
      repos: [{
        url: FLEET_REPO,
        defaultBranch: "main",
        platform: "backend",
      }],
    },
    sources: prd.sources || [],
  };

  const resp = await fetch(`${WORKFLOW_API}/api/workflow/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[prd-submitter] API ${resp.status}: ${err}`);
    return { statusCode: resp.status, body: err };
  }

  const { workflowId, epicId } = await resp.json();
  console.log(`[prd-submitter] Workflow started: ${workflowId} (epic: ${epicId})`);
  return { statusCode: 200, body: JSON.stringify({ workflowId, epicId }) };
}
