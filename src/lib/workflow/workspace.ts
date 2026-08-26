/**
 * Agent Workspace Management
 *
 * Manages per-agent resources during workflow execution:
 * - S3 artifact storage (read/write design docs, code, reviews)
 * - Code Interpreter session lifecycle (start/stop sandboxes for dev agents)
 * - Git branch tracking
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { ARTIFACT_BUCKET, getWorkflowS3Prefix, getSharedArtifactsPrefix } from "./agent-setup";

const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";

// S3 client cache
const s3Clients = new Map<string, S3Client>();

function getS3Client(region: string = DEFAULT_REGION): S3Client {
  let client = s3Clients.get(region);
  if (!client) {
    client = new S3Client({ region });
    s3Clients.set(region, client);
  }
  return client;
}

// ─── S3 Artifact Operations ─────────────────────────────────────────────────

/**
 * Write an artifact to S3 (agent's workspace or shared area).
 */
export async function writeArtifact(params: {
  workflowId: string;
  agentId: string;
  filename: string;
  content: string;
  contentType?: string;
  shared?: boolean; // If true, write to shared prefix (readable by all agents)
}): Promise<string> {
  const client = getS3Client();
  const prefix = params.shared
    ? getSharedArtifactsPrefix(params.workflowId)
    : getWorkflowS3Prefix(params.workflowId, params.agentId);
  const key = `${prefix}${params.filename}`;

  await client.send(
    new PutObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: key,
      Body: params.content,
      ContentType: params.contentType || "text/markdown",
    })
  );

  return `s3://${ARTIFACT_BUCKET}/${key}`;
}

/**
 * List all artifacts for a workflow (optionally filtered by agent).
 */
export async function listArtifacts(params: {
  workflowId: string;
  agentId?: string;
}): Promise<Array<{ key: string; size: number; lastModified?: Date }>> {
  const client = getS3Client();
  const prefix = params.agentId
    ? getWorkflowS3Prefix(params.workflowId, params.agentId)
    : `workflows/${params.workflowId}/`;

  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: ARTIFACT_BUCKET,
      Prefix: prefix,
    })
  );

  return (response.Contents || []).map((obj) => ({
    key: obj.Key || "",
    size: obj.Size || 0,
    lastModified: obj.LastModified,
  }));
}
