import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getEvalConfig, clearSessionBuffer } from "@/lib/eval-config";

const REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET = process.env.ARTIFACT_BUCKET || process.env.ARTIFACTS_BUCKET;

// Raw batches are archived here. NEVER the prd/ prefix — prd-submitter treats
// every prd/ object as a synthesized PRD and starts a workflow from it, so a
// raw batch there becomes an "[SI] undefined" run.
const BATCH_PREFIX = "fleet-imp-agent/batches";

const s3 = new S3Client({ region: REGION });

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const { agentId } = params;

  if (!S3_BUCKET) {
    return NextResponse.json(
      {
        error:
          "ARTIFACT_BUCKET (or ARTIFACTS_BUCKET) env var is required. Convention: agentcore-hub-artifacts-{ACCOUNT_ID}-{REGION}",
      },
      { status: 500 }
    );
  }

  const config = await getEvalConfig(agentId);
  if (!config) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const buffer = config.sessionBuffer;
  if (!buffer || !Array.isArray(buffer) || buffer.length === 0) {
    return NextResponse.json({ error: "Buffer is empty" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const safeTimestamp = now.replace(/:/g, "-");
  const s3Key = `${BATCH_PREFIX}/batch-${agentId}-${safeTimestamp}.json`;

  const batchBody = JSON.stringify({
    agentId,
    batchSize: buffer.length,
    flushedAt: now,
    sessions: buffer,
  });

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: batchBody,
    ContentType: "application/json",
  }));

  await clearSessionBuffer(agentId, now);

  console.log(`[eval-config] Flushed buffer for ${agentId}: batchSize=${buffer.length}, s3Key=${s3Key}`);

  return NextResponse.json({
    flushed: true,
    batchSize: buffer.length,
    s3Key,
  });
}
