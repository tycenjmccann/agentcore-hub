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

// --- Routines ---

export const RoutineScheduleSchema = z.object({
  expression: z.string().min(1),
  timezone: z.string().optional(),
});

// Mirrors RoutineInputTemplate (src/lib/routines/types.ts): the payload template
// POSTed to /api/workflow/start on each fire. {date} in titleTemplate is
// substituted with the fire date.
export const RoutineInputTemplateSchema = z.object({
  titleTemplate: z.string().min(1),
  description: z.string().min(1),
  workflowDefId: z.string().min(1),
  repoConfig: z
    .object({
      layout: z.enum(["monorepo", "multi-repo"]).optional(),
      repos: z.array(
        z.object({
          url: z.string().url(),
          defaultBranch: z.string().optional(),
          platform: z.string().optional(),
        })
      ),
    })
    .optional(),
  sources: z.array(IntakeSourceSchema).optional(),
  connectors: z.array(z.string()).optional(),
});

export const CreateRoutineInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  workflowDefId: z.string().min(1),
  schedule: RoutineScheduleSchema,
  input: RoutineInputTemplateSchema,
  enabled: z.boolean().optional().default(true),
});

export const ListRoutinesInputSchema = z.object({});

export const GetRoutineInputSchema = z.object({
  routineId: z.string().min(1),
});

export const UpdateRoutineInputSchema = z.object({
  routineId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: RoutineScheduleSchema.optional(),
  input: RoutineInputTemplateSchema.partial().optional(),
});

export const DeleteRoutineInputSchema = z.object({
  routineId: z.string().min(1),
});

export const RunRoutineInputSchema = z.object({
  routineId: z.string().min(1),
});
