/**
 * GET    /api/cloud-code/github  → GitHub App connection status (no token material)
 * DELETE /api/cloud-code/github  → disconnect (forget the installation)
 *
 * The connection is just an installation_id + display metadata; clone tokens are
 * minted on demand at turn time (see github-app.ts) and never stored or returned.
 */

import { NextRequest, NextResponse } from "next/server";
import { getIdentity, isAdmin } from "@/lib/auth/identity";
import { getGithubConnection, deleteGithubConnection } from "@/lib/cloud-code/github-store";
import { githubAppConfigured } from "@/lib/cloud-code/github-app";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { tenantId, userId } = getIdentity(request);
    const [appConfigured, conn] = await Promise.all([
      githubAppConfigured(),
      getGithubConnection(tenantId, userId),
    ]);
    return NextResponse.json({
      appConfigured,
      // Admins see a setup entry point even before the App exists (the install
      // route sends them into the manifest-creation flow); non-admins don't.
      isAdmin: isAdmin(request),
      connection: conn
        ? {
            account: conn.account,
            repoSelection: conn.repoSelection,
            repoCount: conn.repositories?.length,
            connectedAt: conn.connectedAt,
          }
        : null,
    });
  } catch (err) {
    console.error("[cloud-code] github status error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { tenantId, userId } = getIdentity(request);
    await deleteGithubConnection(tenantId, userId);
    return NextResponse.json({ disconnected: true });
  } catch (err) {
    console.error("[cloud-code] github disconnect error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
