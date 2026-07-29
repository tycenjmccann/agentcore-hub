#!/usr/bin/env node
import { config } from "./config.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { request, type ClientError } from "./client.js";
import {
  SubmitWorkflowInputSchema,
  ListWorkflowsInputSchema,
  ListWorkflowDefinitionsInputSchema,
  GetWorkflowStatusInputSchema,
  GetWorkflowArtifactsInputSchema,
  CancelWorkflowInputSchema,
  NudgeWorkflowInputSchema,
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

const TOOLS = [
  {
    name: "submit_workflow",
    description:
      "Submit a new workflow for processing. Requires a title, description, and repository configuration. Sources and model override are optional.",
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
              minItems: 1,
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
        workflowType: { type: "string", enum: ["feature", "bug"] },
        workflowDefId: { type: "string" },
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
      "Send a nudge to a running workflow. Optionally provide a message with additional context or instructions to guide its execution.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: { type: "string", minLength: 1 },
        message: { type: "string" },
      },
    },
  },
];

// --- Tool handlers ---

async function handleSubmitWorkflow(args: unknown) {
  const parsed = SubmitWorkflowInputSchema.safeParse(args);
  if (!parsed.success) {
    return zodError(parsed.error);
  }

  const result = await request<{ id: string; status: string; workflowId: string; epicId: string }>(
    "POST",
    "/api/workflow/start",
    parsed.data
  );

  if (!result.ok) {
    return apiError(result);
  }

  return success(
    `Workflow submitted successfully.\nWorkflow ID: ${result.data.workflowId ?? result.data.id}\nEpic ID: ${result.data.epicId ?? "N/A"}\nStatus: ${result.data.status ?? "started"}`
  );
}

async function handleListWorkflows(args: unknown) {
  const parsed = ListWorkflowsInputSchema.safeParse(args);
  if (!parsed.success) {
    return zodError(parsed.error);
  }

  const params = new URLSearchParams();
  params.set("includeArchived", parsed.data.includeArchived ? "1" : "0");

  const result = await request("GET", `/api/workflow/list?${params.toString()}`);
  if (!result.ok) return apiError(result);

  return success(JSON.stringify(result.data, null, 2));
}

async function handleListWorkflowDefinitions(_args: unknown) {
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

  const body = parsed.data.message ? { message: parsed.data.message } : undefined;
  const result = await request(
    "POST",
    `/api/workflow/${encodeURIComponent(parsed.data.workflowId)}/nudge`,
    body
  );
  if (!result.ok) return apiError(result);

  return success(`Nudge sent to workflow ${parsed.data.workflowId}.`);
}

// --- MCP Server setup ---

const server = new Server(
  { name: "workflow-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
    default:
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      };
  }
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("workflow-mcp ready (stdio)");
