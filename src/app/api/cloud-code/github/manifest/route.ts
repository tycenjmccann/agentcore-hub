/**
 * GET /api/cloud-code/github/manifest  → one-time GitHub App creation (operator).
 *
 * Two phases of the GitHub App Manifest flow:
 *   1. No ?code — render a page that auto-POSTs an App manifest to GitHub. The
 *      operator confirms on GitHub, which creates the App and redirects back here.
 *   2. ?code=<temp> — exchange it for the created App's id + private key, store
 *      them in Secrets Manager (cloud-code/github-app), and bounce to /cloud-code.
 *
 * Gated to admins: creating the App writes the deploy-level master credential.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  exchangeManifestCode,
  resetGithubAppConfigCache,
  issueInstallState,
  issueManifestState,
  verifyManifestState,
} from "@/lib/cloud-code/github-app";
import { putGithubAppConfig } from "@/lib/cloud-code/github-secrets";
import { getIdentity, isAdmin } from "@/lib/auth/identity";

export const dynamic = "force-dynamic";

function appBase(request: NextRequest): string {
  return (process.env.DEPLOYMENT_URL || request.nextUrl.origin || "").replace(/\/$/, "");
}

export async function GET(request: NextRequest) {
  const base = appBase(request);

  if (!isAdmin(request)) {
    return NextResponse.redirect(`${base}/cloud-code?github=forbidden`);
  }

  const { userId } = getIdentity(request);
  const code = request.nextUrl.searchParams.get("code");

  // Phase 2 — GitHub returned a temporary code; convert it to App credentials.
  if (code) {
    // CSRF guard: only exchange a code that came from OUR phase-1 form. Without
    // this, an attacker could create an App from their OWN manifest pointing here
    // as redirect_url, capture the temp code, then lure an admin to
    // …/manifest?code=<attacker> — and we'd store the attacker's App as ours.
    // GitHub echoes back the `state` we put in the manifest.
    const state = request.nextUrl.searchParams.get("state") || "";
    if (!(await verifyManifestState(state, userId))) {
      return NextResponse.redirect(`${base}/cloud-code?github=state_mismatch`);
    }
    try {
      const app = await exchangeManifestCode(code);
      await putGithubAppConfig({
        appId: app.appId,
        privateKey: app.privateKey,
        slug: app.slug,
        webhookSecret: app.webhookSecret,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
      });
      resetGithubAppConfigCache();
      // Send the operator to GitHub to install the freshly created App, carrying
      // a signed state so the connect callback binds the install to this admin.
      const installState = await issueInstallState(userId);
      const install = new URL(`https://github.com/apps/${app.slug}/installations/new`);
      install.searchParams.set("state", installState);
      return NextResponse.redirect(install.toString());
    } catch (err) {
      console.error("[cloud-code] github manifest exchange error:", err);
      return NextResponse.redirect(`${base}/cloud-code?github=app_error`);
    }
  }

  // Phase 1 — render an auto-submitting manifest form. App installs bounce to the
  // connect callback; the App-creation code returns to THIS route.
  const manifest = {
    name: process.env.GITHUB_APP_NAME || "AgentCore Hub",
    url: base,
    hook_attributes: { active: false },
    redirect_url: `${base}/api/cloud-code/github/manifest`,
    callback_urls: [`${base}/api/cloud-code/github/callback`],
    setup_url: `${base}/api/cloud-code/github/callback`,
    // Ask GitHub to run the OAuth flow AS PART OF install, so the install
    // callback carries a `code` we exchange for a user token — that's how we
    // prove the connecting user actually controls the installation.
    request_oauth_on_install: true,
    public: false,
    // contents:write → clone/push; metadata:read is mandatory; pull_requests:write
    // → `gh pr create` (a core agent step after pushing a branch). members:read
    // lets the install callback verify an org admin via /user/memberships/orgs.
    default_permissions: {
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      members: "read",
    },
  };

  // Signed state GitHub echoes to our redirect_url — verified in phase 2 so we
  // only ever exchange a code that originated from THIS admin's form submission.
  const manifestState = await issueManifestState(userId);
  const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(manifestState)}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Creating GitHub App…</title></head>
<body style="font-family:system-ui;background:#0b0b0d;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<form id="f" method="post" action="${action}">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<p>Redirecting to GitHub to create the app…</p>
<script>document.getElementById('f').submit();</script>
</body></html>`;

  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
