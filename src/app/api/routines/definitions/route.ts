/**
 * GET /api/routines/definitions
 *
 * Workflow definitions for the New Routine form's picker. Reads the LIVE
 * config/workflows.json from S3 (the same doc the orchestrator runs from), so
 * defs created by the Routine Builder appear here too — the bundled copy would
 * miss them. Falls back to the bundled defs if S3 is unavailable.
 */

import { NextResponse } from "next/server";
import { WORKFLOW_DEFS, DEFAULT_WORKFLOW_DEF_ID } from "@/lib/workflow/workflow-defs";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

interface DefShape {
  id: string;
  name: string;
  description?: string;
  requiresRepo?: boolean;
}

function trim(defs: DefShape[]): DefShape[] {
  return defs.map((w) => ({ id: w.id, name: w.name, description: w.description, requiresRepo: w.requiresRepo }));
}

export async function GET() {
  const fallback = {
    defaultWorkflowDefId: DEFAULT_WORKFLOW_DEF_ID,
    workflows: trim(WORKFLOW_DEFS as DefShape[]),
  };
  if (!ARTIFACT_BUCKET) return NextResponse.json(fallback);

  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: "config/workflows.json" }));
    const doc = JSON.parse(await obj.Body!.transformToString());
    const workflows = Array.isArray(doc) ? doc : doc.workflows || [];
    return NextResponse.json({
      defaultWorkflowDefId: doc.defaultWorkflowDefId || DEFAULT_WORKFLOW_DEF_ID,
      workflows: trim(workflows),
    });
  } catch {
    return NextResponse.json(fallback);
  }
}
