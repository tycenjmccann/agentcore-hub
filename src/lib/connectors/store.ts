/**
 * Connector registry store — config/connectors.json in the artifact bucket (S3).
 *
 * Same pattern as the agents/workflows config: a single JSON doc in S3 that both
 * the Next app (writes) and the runtime (reads on invoke) share. The registry
 * holds ONLY metadata + secret-key names — never a secret value (those go to
 * Secrets Manager via secrets.ts). Connectors are tenant-agnostic today (the
 * fleet is single-tenant); the doc is global, matching config/agents.json.
 */

import { randomUUID } from "crypto";
import type { Connector, ConnectorRegistry } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const KEY = "config/connectors.json";

async function s3() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({ region: REGION });
}

export async function readRegistry(): Promise<ConnectorRegistry> {
  if (!ARTIFACT_BUCKET) return { connectors: [] };
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    const obj = await (await s3()).send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: KEY }));
    const text = await obj.Body!.transformToString();
    const doc = JSON.parse(text) as ConnectorRegistry;
    return { connectors: doc.connectors || [] };
  } catch (err) {
    // NoSuchKey → empty registry (first connector creates the doc).
    if ((err as { name?: string }).name === "NoSuchKey") return { connectors: [] };
    throw err;
  }
}

async function writeRegistry(reg: ConnectorRegistry): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await (await s3()).send(
    new PutObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: KEY,
      Body: JSON.stringify(reg, null, 2),
      ContentType: "application/json",
    })
  );
}

export async function listConnectors(): Promise<Connector[]> {
  return (await readRegistry()).connectors;
}

export async function getConnector(id: string): Promise<Connector | null> {
  return (await readRegistry()).connectors.find((c) => c.id === id) || null;
}

/** Create or replace a connector. `id` is generated for new connectors. */
export async function putConnector(
  input: Omit<Connector, "id" | "createdAt" | "updatedAt"> & { id?: string }
): Promise<Connector> {
  const reg = await readRegistry();
  const now = new Date().toISOString();
  const existing = input.id ? reg.connectors.find((c) => c.id === input.id) : undefined;
  const connector: Connector = {
    ...input,
    id: input.id || `conn-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  reg.connectors = [...reg.connectors.filter((c) => c.id !== connector.id), connector];
  await writeRegistry(reg);
  return connector;
}

/** Apply a mutation to a connector and persist. Returns null if not found. */
export async function mutateConnector(
  id: string,
  fn: (c: Connector) => Connector
): Promise<Connector | null> {
  const reg = await readRegistry();
  const idx = reg.connectors.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const updated = { ...fn(reg.connectors[idx]), id, updatedAt: new Date().toISOString() };
  reg.connectors[idx] = updated;
  await writeRegistry(reg);
  return updated;
}

export async function deleteConnector(id: string): Promise<boolean> {
  const reg = await readRegistry();
  const next = reg.connectors.filter((c) => c.id !== id);
  if (next.length === reg.connectors.length) return false;
  reg.connectors = next;
  await writeRegistry(reg);
  return true;
}
