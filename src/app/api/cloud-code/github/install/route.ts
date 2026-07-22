/**
 * GET /api/cloud-code/github/install  → redirect the user to GitHub to install
 * the (already-created) App on their account/repos. GitHub bounces back to the
 * connect callback with the installation_id.
 *
 * If no App exists yet, an admin is sent to the manifest creation flow; a
 * non-admin gets a clear "ask your operator" bounce.
 */

import { NextRequest, NextResponse } from "next/server";
import { getGithubAppConfig } from "@/lib/cloud-code/github-secrets";
import { getIdentity, isAdmin } from "@/lib/auth/identity";
import { issueInstallState } from "@/lib/cloud-code/github-app";

export const dynamic = "force-dynamic";

function appBase(request: NextRequest): string {
  return (process.env.DEPLOYMENT_URL || request.nextUrl.origin || "").replace(/\/$/, "");
}

export async function GET(request: NextRequest) {
  const base = appBase(request);
  const cfg = await getGithubAppConfig();

  if (!cfg) {
    // No App yet: admins create one, everyone else waits for the operator.
    if (isAdmin(request)) {
      return NextResponse.redirect(`${base}/api/cloud-code/github/manifest`);
    }
    return NextResponse.redirect(`${base}/cloud-code?github=not_configured`);
  }

  if (!cfg.slug) {
    return NextResponse.redirect(`${base}/cloud-code?github=app_error`);
  }
  // Bind this install flow to the signed-in user so the callback can prove the
  // installation was authorized by THIS user (GitHub echoes ?state= back).
  const { userId } = getIdentity(request);
  const state = await issueInstallState(userId);
  const url = new URL(`https://github.com/apps/${cfg.slug}/installations/new`);
  url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString());
}
