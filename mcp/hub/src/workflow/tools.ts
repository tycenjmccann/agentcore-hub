/**
 * Workflow + routine tools — the hub's agent-pipeline surface.
 * Ported verbatim from the standalone workflow-mcp; the only change is the
 * shared authenticated client (auth.js) replacing the local one.
 */
import { z } from "zod";
import { request, type ClientError } from "../auth.js";
import {
  SubmitWorkflowInputSchema,
  ListWorkflowsInputSchema,
  ListWorkflowDefinitionsInputSchema,
  GetWorkflowStatusInputSchema,
  GetWorkflowArtifactsInputSchema,
  CancelWorkflowInputSchema,
  NudgeWorkflowInputSchema,
  CreateRoutineInputSchema,
  ListRoutinesInputSchema,
  GetRoutineInputSchema,
  UpdateRoutineInputSchema,
  DeleteRoutineInputSchema,
  RunRoutineInputSchema,
} from "./schemas.js";

// --- Response helpers ---

function success(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function apiError(error: ClientError) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error.message }],
  };
}

function zodError(error: z.ZodError) {
  const issues = error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Validation error:\n${issues}` }],
  };
}

// --- Tool definitions ---

export const WORKFLOW_TOOLS = [
  {
    name: "submit_workflow",
    description:
      "Submit a new workflow for processing. Requires a title, description, and repository configuration. " +
      "workflowDefId is the pipeline selector — pick an id from list_workflow_definitions (e.g. 'bug-fix' for bug runs; " +
      "omitted → the default 'software-delivery' pipeline). workflowType is a DEPRECATED back-compat alias: without " +
      "workflowDefId it maps to a def ('bug' → 'bug-fix', 'feature' → 'software-delivery'); when both are supplied the " +
      "def wins and the run's stored type is derived from it. Sources and model override are optional.",
    inputSchema: {
      type: "object",
      required: ["title", "description", "repoConfig"],
      properties: {
        title: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
        repoConfig: {
          type: "object",
          required: ["layout", "repos"],
          properties: {
            layout: { type: "string", enum: ["monorepo", "multi-repo"] },
            repos: {
              type: "array",
              items: {
                type: "object",
                required: ["url", "defaultBranch", "platform"],
                properties: {
                  url: { type: "string", format: "uri" },
                  defaultBranch: { type: "string", minLength: 1 },
                  pathPrefix: { type: "string" },
                  platform: { type: "string", enum: ["ios", "backend", "android", "shared"] },
                },
              },
            },
          },
        },
        sources: {
          type: "array",
          items: {
            type: "object",
            required: ["type", "value"],
            properties: {
              type: { type: "string", enum: ["url", "upload", "s3"] },
              value: { type: "string", minLength: 1 },
              contentType: { type: "string" },
              label: { type: "string" },
            },
          },
          default: [],
        },
        modelOverride: {
          type: "object",
          properties: {
            bedrockModelConfig: {
              type: "object",
              properties: { modelId: { type: "string" } },
              required: ["modelId"],
            },
            openAiModelConfig: {
              type: "object",
              properties: {
                modelId: { type: "string" },
                apiKeyArn: { type: "string" },
              },
              required: ["modelId", "apiKeyArn"],
            },
          },
        },
        workflowType: {
          type: "string",
          enum: ["feature", "bug"],
          description:
            "DEPRECATED — use workflowDefId to select the pipeline. Back-compat alias only: without workflowDefId it " +
            "maps 'bug' → the 'bug-fix' def and 'feature' → the default 'software-delivery' def; when workflowDefId is " +
            "also supplied the def wins and the stored workflowType is derived from it (when they contradict, the " +
            "response carries workflowTypeOverridden: true plus a note).",
        },
        workflowDefId: {
          type: "string",
          description:
            "The pipeline selector: id of a workflow definition from list_workflow_definitions (e.g. " +
            "'software-delivery', 'bug-fix'). Unknown ids are rejected with a 400 — never a silent fallback.",
        },
        reviewGates: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "list_workflows",
    description:
      "List workflows. Optionally include archived workflows by setting includeArchived to true.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "list_workflow_definitions",
    description:
      "List all available workflow definitions (templates) that can be used with submit_workflow's workflowDefId parameter.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_workflow_status",
    description:
      "Get the current status and state of a specific workflow by its ID.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "get_workflow_artifacts",
    description:
      "Retrieve artifacts produced by a workflow. Optionally filter by agent ID.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: { type: "string", minLength: 1 },
        agentId: { type: "string" },
      },
    },
  },
  {
    name: "cancel_workflow",
    description:
      "Cancel a running workflow. Optionally provide a reason for the cancellation.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: { type: "string", minLength: 1 },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "nudge_workflow",
    description:
      "Nudge a workflow: scan its tickets and auto-fix any that are stuck (e.g. re-transition blocked tickets). Note: this does not deliver instructions to a running agent — it only unblocks stalled tickets.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "create_routine",
    description:
      "Create a routine: a workflow that runs on a schedule (EventBridge Scheduler expression, e.g. 'rate(7 days)' or 'cron(0 9 ? * MON *)'). The workflowDefId must already exist (see list_workflow_definitions). Minimum cadence is one fire per hour — each fire runs a full agent pipeline. input.titleTemplate may contain {date}, replaced with the fire date.",
    inputSchema: {
      type: "object",
      required: ["name", "workflowDefId", "schedule", "input"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string" },
        workflowDefId: { type: "string", minLength: 1 },
        schedule: {
          type: "object",
          required: ["expression"],
          properties: {
            expression: {
              type: "string",
              minLength: 1,
              description: "EventBridge Scheduler expression: rate(...) or cron(...)",
            },
            timezone: { type: "string", description: "IANA timezone the cron is evaluated in (default UTC)" },
          },
        },
        input: {
          type: "object",
          required: ["titleTemplate", "description", "workflowDefId"],
          properties: {
            titleTemplate: { type: "string", minLength: 1, description: "Workflow title; {date} is replaced with the fire date" },
            description: { type: "string", minLength: 1 },
            workflowDefId: { type: "string", minLength: 1 },
            repoConfig: {
              type: "object",
              required: ["repos"],
              properties: {
                layout: { type: "string", enum: ["monorepo", "multi-repo"] },
                repos: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["url"],
                    properties: {
                      url: { type: "string", format: "uri" },
                      defaultBranch: { type: "string" },
                      platform: { type: "string" },
                    },
                  },
                },
              },
            },
            sources: {
              type: "array",
              items: {
                type: "object",
                required: ["type", "value"],
                properties: {
                  type: { type: "string", enum: ["url", "upload", "s3"] },
                  value: { type: "string", minLength: 1 },
                  contentType: { type: "string" },
                  label: { type: "string" },
                },
              },
            },
            connectors: {
              type: "array",
              items: { type: "string" },
              description: "Connector ids applied to this routine's runs. Must already be bound to an agent in the workflow def.",
            },
          },
        },
        enabled: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "list_routines",
    description: "List all routines (scheduled workflows) with their schedule, enabled state, and last run result.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_routine",
    description: "Get a single routine by its ID, including its full input template and last run.",
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: { routineId: { type: "string", minLength: 1 } },
    },
  },
  {
    name: "update_routine",
    description:
      "Update a routine: enable/pause it, rename it, or change its schedule or input template. Only the provided fields change.",
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: {
        routineId: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string" },
        enabled: { type: "boolean" },
        schedule: {
          type: "object",
          required: ["expression"],
          properties: {
            expression: { type: "string", minLength: 1 },
            timezone: { type: "string" },
          },
        },
        input: { type: "object", description: "Partial input template; merged over the existing one" },
      },
    },
  },
  {
    name: "delete_routine",
    description: "Delete a routine and its schedule. The routine stops firing immediately. This cannot be undone.",
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: { routineId: { type: "string", minLength: 1 } },
    },
  },
  {
    name: "run_routine",
    description:
      "Fire a routine immediately ('Run now') without waiting for its schedule. Starts a workflow from the routine's input template and records it as the routine's last run.",
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: { routineId: { type: "string", minLength: 1 } },
    },
  },
];

// --- Tool handlers ---

async function handleSubmitWorkflow(args: unknown) {
  const parsed = SubmitWorkflowInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const result = await request<{
    id?: string;
    workflowId?: string;
    epicId?: string;
    status?: string;
    workflowTypeOverridden?: boolean;
    note?: string;
  }>(
    "POST",
    "/api/workflow/start",
    parsed.data
  );

  if (!result.ok) return apiError(result);

  const d = result.data;
  const id = d.workflowId || d.id || "unknown";
  const lines = [`Workflow submitted successfully.`, `ID: ${id}`];
  if (d.epicId) lines.push(`Epic: ${d.epicId}`);
  if (d.status) lines.push(`Status: ${d.status}`);
  // TEAM-3832: the def is the pipeline selector — tell the caller when their
  // deprecated workflowType alias contradicted it and was overridden.
  if (d.workflowTypeOverridden && d.note) lines.push(`Note: ${d.note}`);
  return success(lines.join("\n"));
}

async function handleListWorkflows(args: unknown) {
  const parsed = ListWorkflowsInputSchema.safeParse(args ?? {});
  if (!parsed.success) return zodError(parsed.error);

  const params = new URLSearchParams();
  params.set("includeArchived", parsed.data.includeArchived ? "1" : "0");

  const result = await request("GET", `/api/workflow/list?${params.toString()}`);
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleListWorkflowDefinitions(_args: unknown) {
  const parsed = ListWorkflowDefinitionsInputSchema.safeParse(_args ?? {});
  if (!parsed.success) return zodError(parsed.error);

  const result = await request("GET", "/api/workflow/definitions");
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleGetWorkflowStatus(args: unknown) {
  const parsed = GetWorkflowStatusInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const result = await request(
    "GET",
    `/api/workflow/${encodeURIComponent(parsed.data.workflowId)}/state`
  );
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleGetWorkflowArtifacts(args: unknown) {
  const parsed = GetWorkflowArtifactsInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const params = new URLSearchParams();
  params.set("workflowId", parsed.data.workflowId);
  if (parsed.data.agentId) params.set("agentId", parsed.data.agentId);

  const result = await request("GET", `/api/workflow/artifacts?${params.toString()}`);
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleCancelWorkflow(args: unknown) {
  const parsed = CancelWorkflowInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const body = parsed.data.reason ? { reason: parsed.data.reason } : undefined;
  const result = await request(
    "POST",
    `/api/workflow/${encodeURIComponent(parsed.data.workflowId)}/cancel`,
    body
  );
  if (!result.ok) return apiError(result);

  return success(`Workflow ${parsed.data.workflowId} cancelled successfully.`);
}

async function handleNudgeWorkflow(args: unknown) {
  const parsed = NudgeWorkflowInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const result = await request(
    "POST",
    `/api/workflow/${encodeURIComponent(parsed.data.workflowId)}/nudge`
  );
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleCreateRoutine(args: unknown) {
  const parsed = CreateRoutineInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const result = await request<{ routine?: { routineId?: string; name?: string; enabled?: boolean } }>(
    "POST",
    "/api/routines",
    parsed.data
  );
  if (!result.ok) return apiError(result);

  const r = result.data.routine;
  return success(
    [
      "Routine created.",
      `ID: ${r?.routineId ?? "unknown"}`,
      `Name: ${r?.name ?? parsed.data.name}`,
      `Enabled: ${r?.enabled ?? true}`,
      `Schedule: ${parsed.data.schedule.expression}${parsed.data.schedule.timezone ? ` (${parsed.data.schedule.timezone})` : ""}`,
    ].join("\n")
  );
}

async function handleListRoutines(args: unknown) {
  const parsed = ListRoutinesInputSchema.safeParse(args ?? {});
  if (!parsed.success) return zodError(parsed.error);

  const result = await request("GET", "/api/routines");
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleGetRoutine(args: unknown) {
  const parsed = GetRoutineInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const result = await request(
    "GET",
    `/api/routines/${encodeURIComponent(parsed.data.routineId)}`
  );
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleUpdateRoutine(args: unknown) {
  const parsed = UpdateRoutineInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const { routineId, ...body } = parsed.data;
  const result = await request(
    "PATCH",
    `/api/routines/${encodeURIComponent(routineId)}`,
    body
  );
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleDeleteRoutine(args: unknown) {
  const parsed = DeleteRoutineInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const result = await request(
    "DELETE",
    `/api/routines/${encodeURIComponent(parsed.data.routineId)}`
  );
  if (!result.ok) return apiError(result);

  return success(`Routine ${parsed.data.routineId} deleted.`);
}

async function handleRunRoutine(args: unknown) {
  const parsed = RunRoutineInputSchema.safeParse(args);
  if (!parsed.success) return zodError(parsed.error);

  const result = await request<{ workflowId?: string }>(
    "POST",
    `/api/routines/${encodeURIComponent(parsed.data.routineId)}/run`
  );
  if (!result.ok) return apiError(result);

  const lines = [`Routine ${parsed.data.routineId} fired.`];
  if (result.data.workflowId) lines.push(`Workflow: ${result.data.workflowId}`);
  return success(lines.join("\n"));
}

/** Dispatch a workflow-domain tool call; null = not one of ours. */
export async function callWorkflowTool(name: string, args: unknown) {
  switch (name) {
    case "submit_workflow":
      return handleSubmitWorkflow(args);
    case "list_workflows":
      return handleListWorkflows(args);
    case "list_workflow_definitions":
      return handleListWorkflowDefinitions(args);
    case "get_workflow_status":
      return handleGetWorkflowStatus(args);
    case "get_workflow_artifacts":
      return handleGetWorkflowArtifacts(args);
    case "cancel_workflow":
      return handleCancelWorkflow(args);
    case "nudge_workflow":
      return handleNudgeWorkflow(args);
    case "create_routine":
      return handleCreateRoutine(args);
    case "list_routines":
      return handleListRoutines(args);
    case "get_routine":
      return handleGetRoutine(args);
    case "update_routine":
      return handleUpdateRoutine(args);
    case "delete_routine":
      return handleDeleteRoutine(args);
    case "run_routine":
      return handleRunRoutine(args);
    default:
      return null;
  }
}
