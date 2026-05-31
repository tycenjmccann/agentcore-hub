/**
 * Intake Processing
 *
 * Handles multi-source input for workflow initiation:
 * - URL: Fetch webpage content, extract text/images
 * - Upload: Process uploaded files (PDF→text, images→base64)
 * - S3: Read objects from user-specified S3 location
 *
 * Processed content is packaged for the requirements agent.
 */

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { writeArtifact } from "./workspace";
import { ARTIFACT_BUCKET } from "./agent-setup";
import type { IntakeSource, WorkflowInput } from "./types";

const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";

interface ProcessedSource {
  type: IntakeSource["type"];
  originalValue: string;
  content: string;
  contentType: string;
  label?: string;
  s3Key?: string; // Where it was stored in the workflow bucket
  isImage?: boolean; // True if this is an image (content is base64)
  imageFormat?: string; // png, jpeg, gif, webp
  isBinary?: boolean; // True if binary non-image (PDF, etc.)
}

// ─── URL Processing ──────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract meaningful content.
 * For HTML pages: strips tags, extracts text content.
 * For images/PDFs: stores as-is with content type.
 */
async function processUrl(url: string): Promise<{ content: string; contentType: string }> {
  // Route s3:// URIs to S3 handler (UI submits them as type "url")
  if (url.startsWith("s3://")) {
    return processS3Source(url);
  }

  // Handle file:// URIs — read from local filesystem
  if (url.startsWith("file://")) {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const filePath = url.replace("file://", "");
      const content = await fs.readFile(filePath, "utf-8");
      const ext = path.extname(filePath).toLowerCase();
      const contentTypeMap: Record<string, string> = {
        ".html": "text/html",
        ".htm": "text/html",
        ".json": "application/json",
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
      };
      const contentType = contentTypeMap[ext] || "text/plain";

      // Images need base64 encoding
      if (contentType.startsWith("image/")) {
        const buffer = await fs.readFile(filePath);
        return {
          content: buffer.toString("base64"),
          contentType,
          isImage: true,
          imageFormat: ext.replace(".", ""),
        } as { content: string; contentType: string; isImage?: boolean; imageFormat?: string };
      }

      return { content, contentType };
    } catch (err) {
      return {
        content: `[Error reading file: ${(err as Error).message}]`,
        contentType: "text/plain",
      };
    }
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "AgentCoreHubWorkflow/1.0 (content-intake)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return {
        content: `[Error fetching URL: ${response.status} ${response.statusText}]`,
        contentType: "text/plain",
      };
    }

    const contentType = response.headers.get("content-type") || "text/plain";

    // HTML content — preserve raw HTML (contains CSS values, structure, animations)
    // Stripping tags would destroy the design spec that agents need to replicate
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      const html = await response.text();
      return { content: html, contentType: "text/html" };
    }

    // JSON content — prettify
    if (contentType.includes("application/json")) {
      const json = await response.json();
      return { content: JSON.stringify(json, null, 2), contentType: "application/json" };
    }

    // Plain text / markdown
    if (contentType.includes("text/")) {
      const text = await response.text();
      return { content: text, contentType };
    }

    // Image content — download binary and base64 encode for S3 storage
    if (contentType.includes("image/")) {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const ext = contentType.split("/")[1]?.split(";")[0] || "png";
      return {
        content: base64,
        contentType,
        isImage: true,
        imageFormat: ext,
      } as { content: string; contentType: string; isImage?: boolean; imageFormat?: string };
    }

    // PDF content — download binary and base64 encode
    if (contentType.includes("application/pdf")) {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return {
        content: base64,
        contentType,
        isBinary: true,
      } as { content: string; contentType: string; isBinary?: boolean };
    }

    // Other binary content — describe what it is
    const size = response.headers.get("content-length") || "unknown";
    return {
      content: `[Binary content: ${contentType}, size: ${size} bytes, URL: ${url}]`,
      contentType,
    };
  } catch (err) {
    return {
      content: `[Error fetching URL "${url}": ${(err as Error).message}]`,
      contentType: "text/plain",
    };
  }
}

/**
 * Strip HTML tags and normalize whitespace.
 */
function stripHtmlTags(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();
  // Truncate if extremely long
  if (text.length > 50000) {
    text = text.slice(0, 50000) + "\n\n[Content truncated at 50,000 characters]";
  }
  return text;
}

// ─── S3 Source Processing ────────────────────────────────────────────────────

/**
 * Read content from an S3 location.
 * Supports s3://bucket/key format.
 */
async function processS3Source(s3Uri: string): Promise<{ content: string; contentType: string; isImage?: boolean; imageFormat?: string; sourceBucket?: string; sourceKey?: string }> {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return {
      content: `[Error: Invalid S3 URI format. Expected s3://bucket/key, got: ${s3Uri}]`,
      contentType: "text/plain",
    };
  }

  const [, bucket, key] = match;

  try {
    const client = new S3Client({ region: DEFAULT_REGION });
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    const contentType = response.ContentType || "application/octet-stream";

    // Text-based content — return directly
    if (contentType.includes("text/") || contentType.includes("json") || contentType.includes("markdown")) {
      const content = (await response.Body?.transformToString()) || "";
      return { content, contentType };
    }

    // Image — mark as image so intake processing copies it to workflow path
    if (contentType.startsWith("image/")) {
      const format = contentType.split("/")[1] || "png";
      return {
        content: `[S3 image: ${contentType}, size: ${response.ContentLength || "unknown"} bytes, key: ${key}]`,
        contentType,
        isImage: true,
        imageFormat: format,
        sourceBucket: bucket,
        sourceKey: key,
      };
    }

    // Other binary — describe
    return {
      content: `[S3 object: ${contentType}, size: ${response.ContentLength || "unknown"} bytes, key: ${key}]`,
      contentType,
    };
  } catch (err) {
    return {
      content: `[Error reading S3 "${s3Uri}": ${(err as Error).message}]`,
      contentType: "text/plain",
    };
  }
}

// ─── Upload Processing ───────────────────────────────────────────────────────

/**
 * Process an uploaded file. The value is a local file path or base64 content.
 * For the MVP, uploaded files are stored in the workflow S3 bucket.
 */
async function processUpload(
  value: string,
  contentType?: string
): Promise<{ content: string; contentType: string }> {
  // In production, the upload route stores the file and passes us the path.
  // For now, treat the value as the content itself.
  const ct = contentType || "text/plain";

  if (ct.includes("text/") || ct.includes("json") || ct.includes("markdown")) {
    return { content: value, contentType: ct };
  }

  return {
    content: `[Uploaded file: ${ct}, size: ${value.length} bytes]`,
    contentType: ct,
  };
}

// ─── Main Processing Pipeline ────────────────────────────────────────────────

/**
 * Process all intake sources and store artifacts in S3.
 * Returns processed sources with content ready for the requirements agent.
 */
export async function processIntakeSources(
  workflowId: string,
  sources: IntakeSource[]
): Promise<ProcessedSource[]> {
  const processed: ProcessedSource[] = [];

  const processPromises = sources.map(async (source, index) => {
    let result: { content: string; contentType: string };

    switch (source.type) {
      case "url":
        result = await processUrl(source.value);
        break;
      case "s3":
        result = await processS3Source(source.value);
        break;
      case "upload":
        result = await processUpload(source.value, source.contentType);
        break;
      default:
        result = { content: `[Unknown source type: ${source.type}]`, contentType: "text/plain" };
    }

    // Determine filename and content type for S3 storage
    const resultAny = result as { content: string; contentType: string; isImage?: boolean; imageFormat?: string; isBinary?: boolean; sourceBucket?: string; sourceKey?: string };
    const isImage = resultAny.isImage || false;
    const imageFormat = resultAny.imageFormat;
    const isBinary = resultAny.isBinary || false;

    const ext = isImage ? (imageFormat || "png") : (isBinary ? "pdf" : "md");
    const filename = `source-${index}-${source.type}.${ext}`;
    const destKey = `workflows/${workflowId}/intake/${filename}`;

    let s3Key: string | undefined;
    try {
      if (isImage && resultAny.sourceBucket && resultAny.sourceKey) {
        // S3 source image — copy directly instead of re-encoding
        const { CopyObjectCommand } = await import("@aws-sdk/client-s3");
        const client = new S3Client({ region: DEFAULT_REGION });
        const bucket = ARTIFACT_BUCKET;
        await client.send(new CopyObjectCommand({
          Bucket: bucket,
          Key: destKey,
          CopySource: `${resultAny.sourceBucket}/${resultAny.sourceKey}`,
          ContentType: result.contentType,
        }));
        s3Key = destKey;
      } else if (isImage || isBinary) {
        // Upload/URL binary — store the raw binary (base64 decoded)
        const contentToStore = Buffer.from(result.content, "base64").toString("binary");
        s3Key = await writeArtifact({
          workflowId,
          agentId: "intake",
          filename,
          content: contentToStore,
          contentType: result.contentType,
          shared: true,
        });
      } else {
        // Text content
        s3Key = await writeArtifact({
          workflowId,
          agentId: "intake",
          filename,
          content: result.content,
          contentType: result.contentType,
          shared: true,
        });
      }
    } catch {
      // S3 write failure is non-fatal — content is still available inline
    }

    return {
      type: source.type,
      originalValue: source.value,
      content: isImage ? `[Image: ${imageFormat}, stored at ${s3Key || filename}]` : result.content,
      contentType: result.contentType,
      label: source.label,
      s3Key,
      isImage,
      imageFormat,
      isBinary,
    };
  });

  const results = await Promise.allSettled(processPromises);
  for (const result of results) {
    if (result.status === "fulfilled") {
      processed.push(result.value);
    }
  }

  return processed;
}

/**
 * Build the full context string for the requirements agent from processed intake.
 */
export function buildRequirementsContext(
  input: WorkflowInput,
  processedSources: ProcessedSource[]
): string {
  let context = `# Product Feature Request\n\n`;
  context += `## Title\n${input.title}\n\n`;

  if (input.description) {
    context += `## Description / PRD\n${input.description}\n\n`;
  }

  if (processedSources.length > 0) {
    context += `## Input Sources\n\n`;
    const imageFiles: string[] = [];

    const MAX_INLINE_SIZE = 30000; // Cap inline content to avoid context overflow

    for (const source of processedSources) {
      context += `### Source: ${source.label || source.originalValue} (${source.type})\n`;
      if (source.isImage && source.s3Key) {
        const filename = source.s3Key.split("/").pop() || "image.png";
        imageFiles.push(`/workspace/intake/${filename}`);
        context += `**[Image file available at /workspace/intake/${filename}]**\n`;
        context += `Use the browser tool to navigate to the presigned URL to view this mockup/screenshot.\n\n`;
      } else if (source.content.length > MAX_INLINE_SIZE && source.s3Key) {
        // Large content: provide first 8K chars + S3 reference for full access
        const bucket = ARTIFACT_BUCKET;
        context += `**[Large file: ${(source.content.length / 1024).toFixed(0)}KB — showing first 8KB, full content at s3://${bucket}/${source.s3Key}]**\n\n`;
        context += `${source.content.slice(0, 8000)}\n\n`;
        context += `... [TRUNCATED — use s3_read tool to access full ${(source.content.length / 1024).toFixed(0)}KB content at s3://${bucket}/${source.s3Key}]\n\n`;
      } else {
        context += `${source.content}\n\n`;
      }
      context += `---\n\n`;
    }

    if (imageFiles.length > 0) {
      context += `## IMPORTANT: Visual Input Available\n`;
      context += `This request includes ${imageFiles.length} image file(s) (mockups, screenshots, designs).\n`;
      context += `You MUST use the \`browser\` tool to navigate to the presigned URLs to view these before analyzing requirements:\n`;
      for (const img of imageFiles) {
        context += `- ${img}\n`;
      }
      context += `\nDo NOT skip the images — they contain critical design/UX information.\n\n`;
    }
  }

  context += `## Repository Configuration\n`;
  context += `Layout: ${input.repoConfig.layout}\n`;
  for (const repo of input.repoConfig.repos) {
    context += `- ${repo.platform}: ${repo.url} (branch: ${repo.defaultBranch}${repo.pathPrefix ? `, path: ${repo.pathPrefix}` : ""})\n`;
  }
  context += `\n`;

  context += `## Instructions\n`;
  context += `Analyze the above input and produce:\n`;
  context += `1. A structured requirements document with acceptance criteria\n`;
  context += `2. A JSON ticket plan specifying which team agents need to be involved\n`;
  context += `\nONLY create tickets for agents that are relevant to this work.\n`;
  context += `Available agents: agentcore_hub_ios_designer, agentcore_hub_backend_designer, agentcore_hub_android_designer, agentcore_hub_security_reviewer, agentcore_hub_legal_compliance, agentcore_hub_localization, agentcore_hub_analytics_designer, agentcore_hub_backend_dev, agentcore_hub_api_dev, agentcore_hub_frontend_dev\n`;

  return context;
}

// ─── Upfront Validation ─────────────────────────────────────────────────────

/**
 * Validate that all intake sources are reachable BEFORE starting the workflow.
 * Returns an array of error strings for any unreachable sources.
 * Empty array = all sources valid.
 */
export async function validateIntakeSources(
  sources: IntakeSource[]
): Promise<string[]> {
  const errors: string[] = [];
  const client = new S3Client({ region: DEFAULT_REGION });

  const checks = sources.map(async (source) => {
    const value = source.value;
    try {
      if (value.startsWith("s3://")) {
        // S3 URI — validate format, skip HEAD for our own artifact bucket
        // (App Runner may not have S3 read permissions, but agents do at runtime)
        const match = value.match(/^s3:\/\/([^/]+)\/(.+)$/);
        if (!match) {
          return `Invalid S3 URI format: ${value}`;
        }
        const [, bucket, key] = match;
        const ownBucket = process.env.ARTIFACT_BUCKET || process.env.AGENTCORE_HUB_ARTIFACT_BUCKET || "";
        if (bucket === ownBucket) {
          return null; // Trust internal references — agent can read at runtime
        }
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return null; // OK
      } else if (value.startsWith("http://") || value.startsWith("https://")) {
        // GitHub URLs from our own repos — trust them (SI loop references)
        if (value.includes("github.com/tycenjmccann/")) {
          return null;
        }
        // HTTP URL — HEAD check
        const res = await fetch(value, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          return `URL unreachable (${res.status}): ${value}`;
        }
        return null; // OK
      }
      // Upload type — skip validation (already in memory)
      return null;
    } catch (err) {
      return `Source unreachable: ${value} — ${(err as Error).message}`;
    }
  });

  const results = await Promise.allSettled(checks);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      errors.push(result.value);
    } else if (result.status === "rejected") {
      errors.push(`Validation error: ${result.reason}`);
    }
  }

  return errors;
}
