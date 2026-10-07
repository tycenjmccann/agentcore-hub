/**
 * TEAM-5374 F1 — cancel_workflow's reason is required, not optional.
 *
 * The route behind this tool (src/app/api/workflow/[id]/cancel/route.ts) 400s
 * reason_required via sanitizeCancelReason (src/lib/workflow/cancel-run.ts)
 * when the body carries no non-blank reason. The MCP schema used to mark
 * `reason` optional and the call site sent `body: undefined` when it was
 * missing, so every reasonless cancel from an MCP client got a 400 the tool
 * never explained. This pins the schema, the JSON tool spec Strands/clients
 * read, and the call site all requiring it.
 *
 * `../auth.js` is mocked: importing it for real runs config.ts, which calls
 * process.exit(1) when HUB_URL is unset (it is, under this repo's root
 * vitest run — mcp/hub is its own deployable with its own env).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../auth.js", () => ({
  request: vi.fn(),
}));

import { request } from "../auth.js";
import { callWorkflowTool, WORKFLOW_TOOLS } from "./tools.js";

const mockRequest = request as unknown as ReturnType<typeof vi.fn>;

const CANCEL_TOOL = WORKFLOW_TOOLS.find((t) => t.name === "cancel_workflow");

beforeEach(() => {
  mockRequest.mockReset();
});

/** callWorkflowTool's return type is `| null` ("not one of ours") and the
 *  success/error response shapes only share `content`; this tool is always
 *  one of ours and every assertion below needs `isError`, so narrow once here
 *  instead of asserting the same two things in every test. */
type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

async function cancelWorkflow(args: unknown): Promise<ToolResult> {
  const result = await callWorkflowTool("cancel_workflow", args);
  expect(result).not.toBeNull();
  return result as ToolResult;
}

describe("cancel_workflow tool spec", () => {
  it("declares reason required, not optional", () => {
    expect(CANCEL_TOOL).toBeDefined();
    expect(CANCEL_TOOL!.inputSchema.required).toContain("reason");
    expect(CANCEL_TOOL!.inputSchema.properties.reason).toMatchObject({
      type: "string",
      minLength: 1,
    });
  });
});

describe("callWorkflowTool('cancel_workflow')", () => {
  it("refuses a missing reason without calling the hub", async () => {
    const result = await cancelWorkflow({ workflowId: "wf_1" });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("refuses a blank/whitespace-only reason without calling the hub", async () => {
    const result = await cancelWorkflow({
      workflowId: "wf_1",
      reason: "   ",
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("refuses a reason over 1000 chars without calling the hub", async () => {
    const result = await cancelWorkflow({
      workflowId: "wf_1",
      reason: "x".repeat(1001),
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("sends the trimmed reason to the cancel route", async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: { status: "cancelled" } });

    await cancelWorkflow({
      workflowId: "wf_1",
      reason: "  user asked  ",
    });

    expect(mockRequest).toHaveBeenCalledWith(
      "POST",
      "/api/workflow/wf_1/cancel",
      { reason: "user asked" },
    );
  });

  it("surfaces the route's response body instead of a canned success message", async () => {
    // TEAM-5373: a 200 can still carry a partial failure (e.g.
    // ticketsLeftRunning) — a fixed success string would hide that from
    // whoever is reading the tool's output.
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { status: "cancelled", ticketsLeftRunning: ["TEAM-1"] },
    });

    const result = await cancelWorkflow({
      workflowId: "wf_1",
      reason: "stop it",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("ticketsLeftRunning");
    expect(result.content[0].text).toContain("TEAM-1");
  });

  it("surfaces the hub's error on a non-ok response", async () => {
    mockRequest.mockResolvedValue({ ok: false, status: 409, message: "Workflow already in terminal state" });

    const result = await cancelWorkflow({
      workflowId: "wf_1",
      reason: "stop it",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("terminal state");
  });
});
