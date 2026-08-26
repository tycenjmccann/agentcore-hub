# Auth-flip runbook — AUTH_MODE=none → cloudflare-access

Everything that must be in place BEFORE setting `AUTH_MODE=cloudflare-access`,
in order. Skipping a step doesn't degrade gracefully — it locks things out.

## 1. Cloudflare Access application

- Create the Access application for the hub's hostname.
- Set env on the app deployment:
  - `CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com`
  - `CF_ACCESS_AUD=<the application's Audience tag>`

## 2. Define the `admin` group (lockout risk)

`isAdmin()` = *everyone* under `AUTH_MODE=none`, but under SSO it fails closed
to membership in the `admin` group. If no Access policy emits that group, **no
one** can create/manage the shared GitHub App after the flip.

- Create an Access group named `admin` containing the operators.
- Confirm the group rides the JWT (`groups` claim) — the CF adapter reads it.
- Note: until the flip, `/api/cloud-code/github/manifest` (App creation) is
  reachable by anyone who can reach the app at all. Flip sooner rather than
  later once the deploy is shared.

## 3. Service token for the hub MCP (headless caller)

The MCP has no browser login. Without this it dies at the first call (401 on
port/checkpoint/warm/config-sync).

- Create a **service token** in Cloudflare Access; allow it in the Access
  application's policy (Service Auth).
- Map the token to a tenant on the app deployment:
  `CF_ACCESS_SERVICE_TENANTS="<token common name>=<tenantId>"` (comma-separated
  for several tokens). An **unmapped** service token is rejected by design.
- Give the credentials to the MCP (either works):
  - env in the MCP registration: `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`
  - or `~/.cloud-code/service-token.json`: `{ "clientId": "…", "clientSecret": "…" }`

## 4. Re-key the legacy `default` rows

Everything written before the flip is keyed to the `default` identity and would
be invisible to real SSO identities (sessions list empty, config bundle gone,
GitHub connection gone).

```bash
# dry run first (prints every row/object it would touch)
node scripts/migrate-default-identity.mjs --tenant acme.com --user alice@acme.com
# then write
node scripts/migrate-default-identity.mjs --tenant acme.com --user alice@acme.com --apply
```

Covers: session rows (`tenantId`/`userId`), `config:default` →
`config:{tenant}:{user}` + the S3 bundle copy to the tenant prefix, and
`github:default` → `github:{tenant}:{user}`. Idempotent; add `--delete-old`
once verified.

## 5. Flip

- Set `AUTH_MODE=cloudflare-access` and redeploy the app.
- Smoke: browser session list loads (step 4 worked), a chat turn on a private
  repo clones (requester-bound App token), the Terminal opens with `gh auth
  status` showing the App token (prepare-path token passthrough), and
  `/mcp__agentcore-hub__port` completes (service token works end to end).

## Notes

- Clone tokens are minted for the **verified requester** on every
  message/warm/shell call — a coworker opening your session clones with *their*
  GitHub App scope, not yours. Under `AUTH_MODE=none` requester == default ==
  creator, so nothing changes until the flip.
- Presigned S3 URLs bypass Access by design (SigV4 query auth); the MCP only
  sends the service token to the app origin.
