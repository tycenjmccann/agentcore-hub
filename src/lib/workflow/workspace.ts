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
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { AgentWorkspace } from "./types";
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

// Active workspaces per workflow
const activeWorkspaces = new Map<string, Map<string, AgentWorkspace>>();

// ─── Workspace Lifecycle ─────────────────────────────────────────────────────

/**
 * Provision a workspace for an agent in a workflow.
 */
export function provisionWorkspace(workflowId: string, agentId: string): AgentWorkspace {
  const workspace: AgentWorkspace = {
    s3Bucket: ARTIFACT_BUCKET,
    s3Prefix: getWorkflowS3Prefix(workflowId, agentId),
  };

  if (!activeWorkspaces.has(workflowId)) {
    activeWorkspaces.set(workflowId, new Map());
  }
  activeWorkspaces.get(workflowId)!.set(agentId, workspace);

  return workspace;
}

/**
 * Get an agent's workspace for a workflow.
 */
export function getWorkspace(workflowId: string, agentId: string): AgentWorkspace | undefined {
  return activeWorkspaces.get(workflowId)?.get(agentId);
}

/**
 * Clean up all workspaces for a completed workflow.
 */
export function cleanupWorkspaces(workflowId: string): void {
  const workspaces = activeWorkspaces.get(workflowId);
  if (!workspaces) return;

  // Note: We don't delete S3 artifacts — they persist for audit/reference.
  // We just clean up in-memory state and Code Interpreter sessions.
  activeWorkspaces.delete(workflowId);
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
 * Read an artifact from S3.
 */
export async function readArtifact(params: {
  workflowId: string;
  agentId?: string;
  filename: string;
  shared?: boolean;
}): Promise<string | null> {
  const client = getS3Client();
  const prefix = params.shared
    ? getSharedArtifactsPrefix(params.workflowId)
    : getWorkflowS3Prefix(params.workflowId, params.agentId || "unknown");
  const key = `${prefix}${params.filename}`;

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: key,
      })
    );
    return (await response.Body?.transformToString()) || null;
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name || "";
    if (errName === "NoSuchKey" || errName === "NotFound") {
      return null;
    }
    throw err;
  }
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

// ─── Code Interpreter Management ────────────────────────────────────────────

/**
 * Start a Code Interpreter session for a dev agent.
 * Returns the session ID. The actual Code Interpreter is managed via
 * AgentCore's built-in Code Interpreter tool or the MCP server.
 */
export async function startCodeInterpreterSession(
  workflowId: string,
  agentId: string
): Promise<string> {
  const sessionId = `ci_${workflowId}_${agentId}_${Date.now()}`;

  const workspace = getWorkspace(workflowId, agentId);
  if (workspace) {
    workspace.codeInterpreterSessionId = sessionId;
  }

  // In production, this would call the AgentCore Code Interpreter API:
  // const { start_code_interpreter_session } = await import("agentcore-mcp");
  // await start_code_interpreter_session({ timeout_seconds: 1800 });
  // For now, the Code Interpreter is accessed through the harness's tool config.

  return sessionId;
}

/**
 * Stop a Code Interpreter session for a dev agent.
 */
export async function stopCodeInterpreterSession(
  workflowId: string,
  agentId: string
): Promise<void> {
  const workspace = getWorkspace(workflowId, agentId);
  if (workspace) {
    // In production, stop the session via AgentCore API
    workspace.codeInterpreterSessionId = undefined;
  }
}

// ─── Git Branch Tracking ────────────────────────────────────────────────────

/**
 * Record that an agent created a feature branch.
 */
export function recordBranch(
  workflowId: string,
  agentId: string,
  branchName: string
): void {
  const workspace = getWorkspace(workflowId, agentId);
  if (workspace) {
    workspace.gitBranch = branchName;
  }
}

/**
 * Get all branches created during a workflow.
 */
export function getWorkflowBranches(workflowId: string): Array<{ agentId: string; branch: string }> {
  const workspaces = activeWorkspaces.get(workflowId);
  if (!workspaces) return [];

  const branches: Array<{ agentId: string; branch: string }> = [];
  for (const [agentId, workspace] of workspaces) {
    if (workspace.gitBranch) {
      branches.push({ agentId, branch: workspace.gitBranch });
    }
  }
  return branches;
}

// ─── Tool Execution Handlers ────────────────────────────────────────────────
// These handlers are called when the harness agent uses its tools.
// They translate the tool invocation into actual S3/CI/Git operations.

/**
 * Handle an s3_read tool call from an agent.
 */
export async function handleS3Read(
  workflowId: string,
  agentId: string,
  key: string
): Promise<string> {
  // Agents can read from their own workspace or shared
  const content = await readArtifact({
    workflowId,
    filename: key,
    shared: key.startsWith("shared/"),
    agentId: key.startsWith("shared/") ? undefined : agentId,
  });
  return content || `[Error: Artifact not found at key: ${key}]`;
}

/**
 * Handle an s3_write tool call from an agent.
 */
export async function handleS3Write(
  workflowId: string,
  agentId: string,
  key: string,
  content: string,
  contentType?: string
): Promise<string> {
  const isShared = key.startsWith("shared/");
  const filename = isShared ? key.replace("shared/", "") : key;

  const uri = await writeArtifact({
    workflowId,
    agentId,
    filename,
    content,
    contentType,
    shared: isShared,
  });

  return `Written to: ${uri}`;
}

/**
 * Handle a git_command tool call from a dev agent.
 * In production, this executes via the Code Interpreter session.
 * The agent's sandbox has git installed and credentials configured.
 */
export async function handleGitCommand(
  workflowId: string,
  agentId: string,
  command: string,
  workingDir?: string
): Promise<string> {
  // Git commands are executed inside the Code Interpreter sandbox.
  // The harness agent's tool execution layer routes git_command calls
  // to the Code Interpreter's execute_command with the git binary.
  //
  // This function would:
  // 1. Get the active Code Interpreter session for this agent
  // 2. Execute: `cd ${workingDir || '/workspace'} && git ${command}`
  // 3. Return stdout/stderr

  const workspace = getWorkspace(workflowId, agentId);
  if (!workspace?.codeInterpreterSessionId) {
    return "[Error: No active Code Interpreter session. Start one first.]";
  }

  // Record branch creation for tracking
  const branchMatch = command.match(/checkout\s+-b\s+(\S+)/);
  if (branchMatch) {
    recordBranch(workflowId, agentId, branchMatch[1]);
  }

  // In production, this calls:
  // await execute_command({ session_id: workspace.codeInterpreterSessionId, command: `git ${command}` });
  return `[Git command queued: git ${command}]`;
}
