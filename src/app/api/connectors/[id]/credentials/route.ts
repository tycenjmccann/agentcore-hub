/**
 * POST /api/connectors/[id]/credentials
 *
 * Body: { values: { <secretKey>: <value>, ... } }
 * Writes the credential bundle to Secrets Manager (connectors/<id>) and flips the
 * connector's status to "active". The value is write-only: this route returns
 * nothing but { ok, status } — it never echoes the secret, and no GET exists to
 * read it back. The LLM/builder never touches this route; only the secure form.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConnector, mutateConnector } from "@/lib/connectors/store";
import { putConnectorSecret } from "@/lib/connectors/secrets";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const connector = await getConnector(id);
  if (!connector) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const values: Record<string, string> = body.values || {};

  // Only persist declared keys; require every declared key to be present + non-empty.
  const missing = connector.secretKeys.filter((k) => !values[k]?.trim());
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing values for: ${missing.join(", ")}` }, { status: 400 });
  }
  const filtered: Record<string, string> = {};
  for (const k of connector.secretKeys) filtered[k] = values[k];

  try {
    await putConnectorSecret(id, filtered);
    const updated = await mutateConnector(id, (c) => ({ ...c, status: "active" }));
    return NextResponse.json({ ok: true, status: updated?.status });
  } catch (err) {
    console.error("[connectors] credential store error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
