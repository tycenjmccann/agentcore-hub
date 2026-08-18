/**
 * GET    /api/connectors/[id]  → one connector (metadata only)
 * PATCH  /api/connectors/[id]  → edit metadata (name/description/url/headers)
 * DELETE /api/connectors/[id]  → remove connector + its Secrets Manager bundle
 *
 * None of these ever return or accept a secret value — credentials flow only
 * through /api/connectors/[id]/credentials.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConnector, mutateConnector, deleteConnector } from "@/lib/connectors/store";
import { deleteConnectorSecret } from "@/lib/connectors/secrets";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const connector = await getConnector(id);
  if (!connector) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ connector });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const updated = await mutateConnector(id, (c) => ({
    ...c,
    name: body.name?.trim() || c.name,
    description: body.description !== undefined ? body.description?.trim() || undefined : c.description,
    urlTemplate: body.urlTemplate !== undefined ? body.urlTemplate?.trim() || undefined : c.urlTemplate,
    headerTemplate: body.headerTemplate !== undefined ? body.headerTemplate : c.headerTemplate,
    gatewayUrl: body.gatewayUrl !== undefined ? body.gatewayUrl?.trim() || undefined : c.gatewayUrl,
    secretKeys: Array.isArray(body.secretKeys) ? body.secretKeys.map(String).filter(Boolean) : c.secretKeys,
  }));
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ connector: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteConnector(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await deleteConnectorSecret(id);
  return NextResponse.json({ deleted: true });
}
