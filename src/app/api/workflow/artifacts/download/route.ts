import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { ARTIFACT_BUCKET } from "@/lib/workflow/agent-setup";

const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";

function getDownloadS3Client(): S3Client {
  return new S3Client({ region: DEFAULT_REGION });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  const workflowId = searchParams.get("workflowId");
  const agentId = searchParams.get("agentId");
  const zip = searchParams.get("zip");

  const client = getDownloadS3Client();

  // Single file download
  if (key && zip !== "true") {
    // Security: only allow access to workflow artifacts
    if (!key.startsWith("workflows/")) {
      return NextResponse.json({ error: "Invalid key: must be within workflows/ prefix" }, { status: 403 });
    }
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key })
      );

      const filename = key.split("/").pop() || "download";
      const contentType = response.ContentType || "application/octet-stream";
      const body = response.Body;

      if (!body) {
        return NextResponse.json({ error: "Empty file" }, { status: 404 });
      }

      const bytes = await body.transformToByteArray();

      return new NextResponse(Buffer.from(bytes), {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(bytes.length),
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Download failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // ZIP download — all files for an agent in a workflow
  if (zip === "true" && workflowId) {
    try {
      const prefix = agentId
        ? `workflows/${workflowId}/agents/${agentId}/`
        : `workflows/${workflowId}/`;

      const listResponse = await client.send(
        new ListObjectsV2Command({ Bucket: ARTIFACT_BUCKET, Prefix: prefix })
      );

      const objects = (listResponse.Contents || []).filter(
        (obj) => obj.Key && !obj.Key.endsWith("/")
      );

      if (objects.length === 0) {
        return NextResponse.json({ error: "No files to download" }, { status: 404 });
      }

      // Build ZIP using JSZip-like approach with raw buffers
      // We'll use a simple concatenation approach for the ZIP format
      // For production, consider using the 'archiver' package
      const { default: JSZip } = await import("jszip");
      const zipInstance = new JSZip();

      for (const obj of objects) {
        if (!obj.Key) continue;
        const fileResponse = await client.send(
          new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: obj.Key })
        );
        if (fileResponse.Body) {
          const bytes = await fileResponse.Body.transformToByteArray();
          const filename = obj.Key.split("/").pop() || "file";
          zipInstance.file(filename, bytes);
        }
      }

      const zipBuffer = await zipInstance.generateAsync({ type: "uint8array" });

      const zipFilename = agentId
        ? `${agentId}-artifacts.zip`
        : `${workflowId}-artifacts.zip`;

      return new NextResponse(Buffer.from(zipBuffer), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${zipFilename}"`,
          "Content-Length": String(zipBuffer.length),
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "ZIP creation failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return NextResponse.json(
    { error: "Provide ?key=X for single file or ?workflowId=X&zip=true for ZIP download" },
    { status: 400 }
  );
}
