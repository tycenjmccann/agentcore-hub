/**
 * Agent Setup — Constants and S3 path helpers
 *
 * Provides shared configuration used by workspace.ts and engine.ts.
 */

export const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

/**
 * Get the S3 prefix for a specific agent's workspace within a workflow.
 * Matches the path pattern agents actually write to: workflows/{wf_id}/{agentId}/
 */
export function getWorkflowS3Prefix(workflowId: string, agentId: string): string {
  return `workflows/${workflowId}/${agentId}/`;
}

/**
 * Get the S3 prefix for shared artifacts (accessible by all agents in a workflow).
 */
export function getSharedArtifactsPrefix(workflowId: string): string {
  return `workflows/${workflowId}/shared/`;
}
