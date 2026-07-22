/**
 * GET /api/cloud-code/github/callback  → GitHub App install redirect target.
 *
 * After a user clicks "Install" (or "Configure") on GitHub, GitHub bounces here
 * with ?installation_id=&setup_action=. We record the installation for the
 * signed-in (tenant, user) and send them back to /cloud-code. Tokens are minted
 * on demand later.
 */

import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import {
  getGithubConnection,
  putGithubConnection,
  deleteGithubConnection,
} from "@/lib/cloud-code/github-store";
import {
  getInstallation,
  verifyInstallState,
  verifyInstallationOwnership,
  githubAppHasOAuth,
} from "@/lib/cloud-code/github-app";

export const dynamic = "force-dynamic";

function appBase(request: NextRequest): string {
  return (process.env.DEPLOYMENT_URL || request.nextUrl.origin || "").replace(/\/$/, "");
}

export async function GET(request: NextRequest) {
  const back = `${appBase(request)}/cloud-code`;
  try {
    const { tenantId, userId } = getIdentity(request);
    const installationId = request.nextUrl.searchParams.get("installation_id") || "";
    const setupAction = request.nextUrl.searchParams.get("setup_action") || "";
    const state = request.nextUrl.searchParams.get("state") || "";
    const code = request.nextUrl.searchParams.get("code") || "";

    // A "request"/cancel with no installation → nothing to store.
    if (!installationId) {
      return NextResponse.redirect(`${back}?github=cancelled`);
    }

    const stateOk = await verifyInstallState(state, userId);

    if (setupAction === "delete") {
      // Never delete on an unauthenticated cross-site GET: without a guard, any
      // site could send a victim's browser here with setup_action=delete and clear
      // their connection (which, with a PAT fallback configured, downgrades the
      // next turn from the user's App scope to the broad PAT). Accept the delete
      // only when provably legitimate: EITHER our signed state, OR (for a
      // GitHub-initiated uninstall redirect, which carries no state) an
      // installation_id that matches the one we actually stored for this user.
      const conn = await getGithubConnection(tenantId, userId).catch(() => null);
      const matchesStored = Boolean(conn && conn.installationId === installationId);
      if (!stateOk && !matchesStored) {
        return NextResponse.redirect(`${back}?github=state_mismatch`);
      }
      await deleteGithubConnection(tenantId, userId);
      return NextResponse.redirect(`${back}?github=disconnected`);
    }

    // Store path: the signed state proves THIS user started an install flow (CSRF
    // + session binding). Necessary but not sufficient — ownership is proven next.
    if (!stateOk) {
      return NextResponse.redirect(`${back}?github=state_mismatch`);
    }

    // Second gate: prove this user actually CONTROLS installationId — not just
    // that they know it. With OAuth-on-install, GitHub appends a `code`; we
    // exchange it for a user token and confirm the installation is in THAT user's
    // /user/installations (and that they administer it).
    //
    // Fail CLOSED: an App with no OAuth creds cannot prove ownership, so we refuse
    // the connect rather than downgrade to state-only binding. The manifest flow
    // always requests OAuth, so this only rejects a hand-created App missing
    // client creds — the operator must add them before users connect.
    if (!(await githubAppHasOAuth())) {
      return NextResponse.redirect(`${back}?github=oauth_required`);
    }
    if (!code) {
      return NextResponse.redirect(`${back}?github=ownership_unverified`);
    }
    const owned = await verifyInstallationOwnership(code, installationId);
    if (!owned) {
      return NextResponse.redirect(`${back}?github=ownership_unverified`);
    }
    const verifiedAccount: string | undefined = owned.login;

    const meta = await getInstallation(installationId);
    await putGithubConnection(
      {
        installationId,
        account: verifiedAccount || meta?.account,
        repoSelection: meta?.repoSelection,
        connectedAt: new Date().toISOString(),
      },
      tenantId,
      userId
    );
    return NextResponse.redirect(`${back}?github=connected`);
  } catch (err) {
    console.error("[cloud-code] github callback error:", err);
    return NextResponse.redirect(`${back}?github=error`);
  }
}
