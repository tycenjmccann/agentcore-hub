import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_REGION,
  submitRecordForApproval,
  setRecordStatus,
  type RecordStatus,
} from "@/lib/agentcore-sdk";

export const dynamic = "force-dynamic";

type Ctx = { params: { registryId: string; recordId: string } };

const ACTION_STATUS: Record<string, RecordStatus> = {
  approve: "APPROVED",
  reject: "REJECTED",
  deprecate: "DEPRECATED",
};

/**
 * POST /api/agentcore/registry/[registryId]/records/[recordId]/approval
 * Drive the record approval lifecycle.
 * Body: { action: "submit" | "approve" | "reject" | "deprecate", statusReason? }
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const body = await req.json();
    const action = body?.action;
    if (!action) {
      return NextResponse.json({ error: "action is required" }, { status: 400 });
    }

    if (action === "submit") {
      const result = await submitRecordForApproval(params.registryId, params.recordId, region);
      return NextResponse.json(result, { status: 202 });
    }

    const status = ACTION_STATUS[action];
    if (!status) {
      return NextResponse.json(
        { error: "Invalid action. Must be one of: submit, approve, reject, deprecate" },
        { status: 400 }
      );
    }

    const result = await setRecordStatus(
      params.registryId,
      params.recordId,
      status,
      body?.statusReason,
      region
    );
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update approval status";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
