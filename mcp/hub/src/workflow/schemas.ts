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

/**
 * TEAM-4091 F3: cap the per-submission source count. Each source costs the
 * server up to two outbound 10s GETs or an S3 HeadObject, all concurrent, so an
 * unbounded array is a request amplifier. This package is standalone (its own
 * tsconfig/node_modules, no @/* alias into src/), so the number is duplicated
 * rather than imported — keep it in step with MAX_INTAKE_SOURCES in
 * src/lib/workflow/source-shape.ts, which guards the REST route.
 */
const MAX_INTAKE_SOURCES = 32;
const MAX_SOURCES_MESSAGE = `sources must have at most ${MAX_INTAKE_SOURCES} items`;

export const IntakeSourceSchema = z.object({
  type: z.enum(["url", "upload", "s3"]),
  value: z.string().min(1),
  contentType: z.string().optional(),
  label: z.string().optional(),
  // TEAM-4054: output-only. Accepted so a source read back from a workflow can be
  // resubmitted verbatim, but the server OVERWRITES whatever a caller sends —
  // "verified" is not forgeable from the client side.
  verification: z
    .object({
      status: z.enum(["verified", "unverified", "skipped"]),
      method: z.string().optional(),
      detail: z.string().optional(),
      checkedAt: z.string().optional(),
    })
    .optional(),
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

// A laptop coding session shipped into the workflow (ship_session_to_workflow):
// its branch becomes the run's shared integration branch and pipeline personas
// resume the session for context instead of starting cold.
export const PortedSessionSchema = z.object({
  sessionId: z.string().min(1),
  claudeSessionId: z.string().min(1),
  cli: z.enum(["claude", "codex"]),
  repo: z.string().optional(),
  branch: z.string().min(1),
});

export const WorkflowInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  repoConfig: RepoConfigSchema,
  sources: z.array(IntakeSourceSchema).max(MAX_INTAKE_SOURCES, MAX_SOURCES_MESSAGE).optional().default([]),
  modelOverride: ModelOverrideSchema,
  // TEAM-3832: workflowType is a DEPRECATED back-compat alias — workflowDefId
  // is the pipeline selector. Without workflowDefId the API maps "bug" → the
  // "bug-fix" def and "feature" → the default; on conflict the def wins and
  // the stored type is derived from it. Still accepted here — do not remove.
  workflowType: z.enum(["feature", "bug"]).optional(),
  workflowDefId: z.string().optional(),
  reviewGates: z.array(z.string()).optional(),
  portedSession: PortedSessionSchema.optional(),
  // Waive the submit-time GitHub pre-flight on a repoConfig URL that
  // definitively does not exist; the intake agent then hunts for the right
  // repo and escalates if it can't. Default: the API rejects with 422.
  allowUnresolvedRepo: z.boolean().optional(),
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
  sources: z.array(IntakeSourceSchema).max(MAX_INTAKE_SOURCES, MAX_SOURCES_MESSAGE).optional(),
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
