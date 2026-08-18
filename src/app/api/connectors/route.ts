/**
 * GET  /api/connectors  → list connectors (metadata only — never secrets)
 * POST /api/connectors  → register a connector (metadata; status starts
 *                         "needs_credentials" unless it needs no secret)
 *
 * Credentials are set separately via /api/connectors/[id]/credentials so the
 * secret value never rides in the same request that creates registry metadata,
 * and so the registry document (S3) provably never contains a secret.
 */

import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { listConnectors, putConnector, getConnector } from "@/lib/connectors/store";
import type { ConnectorKind } from "@/lib/connectors/types";

/** A url/header target must be https — a plaintext endpoint would leak the
 *  connector's token in the header/query on the wire. Mirrors register_connector.py. */
function badScheme(...urls: (string | undefined)[]): string | null {
  for (const u of urls) {
    if (u && !u.startsWith("https://")) return `"${u}" must be an https:// URL`;
  }
  return null;
}

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const connectors = await listConnectors();
    return NextResponse.json({ connectors });
  } catch (err) {
    console.error("[connectors] list error:", err);
    return NextResponse.json({ error: (err as Error).message, connectors: [] }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = getIdentity(request);
    const body = await request.json().catch(() => ({}));

    const name: string = (body.name?.trim() || "").slice(0, 120);
    const kind: ConnectorKind = body.kind;
    if (!name || !["env", "mcp", "gateway"].includes(kind)) {
      return NextResponse.json(
        { error: "name and kind (env|mcp|gateway) are required" },
        { status: 400 }
      );
    }

    const secretKeys: string[] = Array.isArray(body.secretKeys)
      ? body.secretKeys.map((k: unknown) => String(k)).filter(Boolean)
      : [];
    // A gateway connector authenticates via the runtime's IAM identity — no secret.
    const needsSecret = kind !== "gateway" && secretKeys.length > 0;

    const schemeErr = badScheme(body.urlTemplate?.trim(), body.gatewayUrl?.trim());
    if (schemeErr) return NextResponse.json({ error: schemeErr }, { status: 400 });

    // SECURITY: refuse to repoint (or re-activate) an EXISTING credentialed connector
    // via this create path. Otherwise a caller could set body.id to a live connector,
    // swap urlTemplate/headerTemplate to an attacker host, and the runtime would ship
    // its secret there on the next invoke. Endpoint changes on an active connector
    // require delete + re-register (which forces credential re-entry). Mirrors the
    // register_connector.py toolkit guard.
    if (body.id) {
      const prior = await getConnector(body.id);
      if (prior) {
        const urlChanged = body.urlTemplate !== undefined && body.urlTemplate?.trim() !== prior.urlTemplate;
        const hdrChanged = body.headerTemplate !== undefined &&
          JSON.stringify(body.headerTemplate) !== JSON.stringify(prior.headerTemplate);
        const gwChanged = body.gatewayUrl !== undefined && body.gatewayUrl?.trim() !== prior.gatewayUrl;
        if (prior.status === "active" && (urlChanged || hdrChanged || gwChanged)) {
          return NextResponse.json(
            { error: `Connector "${body.id}" is active; delete and re-register to change its endpoint (forces credential re-entry).` },
            { status: 409 }
          );
        }
      }
    }

    const connector = await putConnector({
      id: body.id,
      name,
      description: body.description?.trim() || undefined,
      kind,
      secretKeys,
      urlTemplate: body.urlTemplate?.trim() || undefined,
      headerTemplate: body.headerTemplate || undefined,
      gatewayUrl: body.gatewayUrl?.trim() || undefined,
      status: needsSecret ? "needs_credentials" : "active",
      createdBy: userId,
    });

    return NextResponse.json({ connector }, { status: 201 });
  } catch (err) {
    console.error("[connectors] create error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
