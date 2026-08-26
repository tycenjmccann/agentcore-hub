#!/usr/bin/env node
/**
 * agentcore-hub-mcp — ONE local stdio MCP server for all of AgentCore Hub.
 *
 * Domains:
 *   workflow/    — submit/inspect/cancel agent-pipeline workflows + routines
 *                  (scheduled workflows). Talks to /api/workflow/* and
 *                  /api/routines/*.
 *   cloud-code/  — port an in-flight laptop coding session to Cloud Code, pull
 *                  it back, and sync CLI config. Talks to /api/cloud-code/*.
 *
 * Supersedes the standalone workflow-mcp and port-session-mcp servers (their
 * tool names are unchanged, so anything calling submit_workflow or
 * port_session_to_cloud keeps working — just re-point the registration).
 *
 * Config via env (set in the MCP server registration):
 *   HUB_URL         — base URL of the deployed hub (required; DEPLOYMENT_URL /
 *                     CLOUD_CODE_URL accepted as legacy fallbacks)
 *   PROJECT_CWD     — project dir for cloud-code porting; defaults to cwd
 *   AUTH_TOKEN      — legacy bearer token (pre-Cloudflare deploys)
 *   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET — Cloudflare Access service
 *                     token once the deploy flips AUTH_MODE=cloudflare-access
 */
import "./config.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WORKFLOW_TOOLS, callWorkflowTool } from "./workflow/tools.js";
import {
  CLOUD_CODE_TOOLS,
  CLOUD_CODE_PROMPTS,
  callCloudCodeTool,
  getCloudCodePrompt,
} from "./cloud-code/tools.js";

const server = new Server(
  { name: "agentcore-hub-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...WORKFLOW_TOOLS, ...CLOUD_CODE_TOOLS],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: CLOUD_CODE_PROMPTS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = getCloudCodePrompt(
    req.params.name,
    req.params.arguments as Record<string, string> | undefined
  );
  if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
  return prompt;
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // MCP makes `arguments` optional; a tool whose fields are all optional
  // (list_workflows, list_workflow_definitions) is legitimately called with
  // none. Default to {} so Zod applies defaults instead of rejecting undefined.
  const { name, arguments: args = {} } = request.params;

  const wf = await callWorkflowTool(name, args);
  if (wf) return wf;
  const cc = await callCloudCodeTool(name, args);
  if (cc) return cc;

  return {
    isError: true,
    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("agentcore-hub-mcp ready (stdio)");
