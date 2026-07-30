import { z } from "zod";

export const RepoTargetSchema = z.object({
  url: z.string().url(),
  defaultBranch: z.string().min(1),
  pathPrefix: z.string().optional(),
  platform: z.enum(["ios", "backend", "android", "shared"]),
});

export const RepoConfigSchema = z.object({
  layout: z.enum(["monorepo", "multi-repo"]),
  // No .min(1): workflow definitions with requiresRepo=false (marketing, sales,
  // legal) are submitted with repos:[], matching the intake form and
  // /api/workflow/start. Requiring a repo would make 3 of 4 defs unsubmittable.
  repos: z.array(RepoTargetSchema),
});

export const IntakeSourceSchema = z.object({
  type: z.enum(["url", "upload", "s3"]),
  value: z.string().min(1),
  contentType: z.string().optional(),
  label: z.string().optional(),
});

export const ModelOverrideSchema = z.object({
  bedrockModelConfig: z.object({
    modelId: z.string(),
  }).optional(),
  openAiModelConfig: z.object({
    modelId: z.string(),
    apiKeyArn: z.string(),
  }).optional(),
}).optional();

export const WorkflowInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  repoConfig: RepoConfigSchema,
  sources: z.array(IntakeSourceSchema).optional().default([]),
  modelOverride: ModelOverrideSchema,
  workflowType: z.enum(["feature", "bug"]).optional(),
  workflowDefId: z.string().optional(),
  reviewGates: z.array(z.string()).optional(),
});

export const SubmitWorkflowInputSchema = WorkflowInputSchema;

export const ListWorkflowsInputSchema = z.object({
  includeArchived: z.boolean().optional().default(false),
});

export const ListWorkflowDefinitionsInputSchema = z.object({});

export const GetWorkflowStatusInputSchema = z.object({
  workflowId: z.string().min(1),
});

export const GetWorkflowArtifactsInputSchema = z.object({
  workflowId: z.string().min(1),
  agentId: z.string().optional(),
});

export const CancelWorkflowInputSchema = z.object({
  workflowId: z.string().min(1),
  reason: z.string().optional(),
});

export const NudgeWorkflowInputSchema = z.object({
  workflowId: z.string().min(1),
});
