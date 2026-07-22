# GitHub App auth — short-lived, scoped clone tokens

Replaces the single shared `GITHUB_PAT` with **GitHub App installation tokens**:
minted server-side in the hub, short-lived (~1h), scoped to the repo a session
touches. The coding agent only ever sees an expiring, narrow token — never the
App's private key. Multi-tenant: a connection is per (tenant, user), so a turn
clones with the token of whoever owns the session, never escalating across
tenants.

## The problem

The runtime clones private repos with a single **`GITHUB_PAT`** — a long-lived
token injected as a runtime env var and written into `~/.gitconfig`. That PAT is
reachable by any agent turn in the microVM (`echo $GITHUB_PAT`,
`cat ~/.gitconfig`), and the microVM runs **untrusted tasks**. A malicious repo
or prompt-injection can exfiltrate it; its blast radius is *every repo the PAT
can touch, forever*. (See also the `GITHUB_PAT` quote-handling bug in
`deploy-one.sh` — the App path removes the shared PAT from the hot path entirely.)

## The fix

| Option | No re-auth? | No long-lived secret? | Blast radius |
|--------|:-----------:|:---------------------:|--------------|
| Shared PAT (today) | ✅ | ❌ | all repos, forever |
| Per-user PAT in Secrets Manager | ✅ | ❌ | all that PAT's repos, forever |
| **GitHub App installation token** | ✅ | ✅ | selected repos, ~1h |

## Trust boundary — who holds what

- **App private key (master credential):** lives ONLY in the hub, in Secrets
  Manager `cloud-code/github-app`. NEVER enters the microVM. The coding-runtime
  IAM role is deliberately given **no** `secretsmanager:GetSecretValue` on it
  (see `deploy/coding-agent-runtime/setup-coding-runtime-role.sh`).
- **Installation token (~1h, repo-scoped):** minted by the hub per turn, passed
  in the invoke payload. The only GitHub credential the agent can reach.

> Rejected: minting inside the runtime. That would require the App private key
> inside the microVM where untrusted agents run — strictly worse than the PAT.

## User experience

One-time setup, then invisible.

**Personal deploy (default, unchanged):** the `GITHUB_PAT` env path still works
with zero new steps. Nobody is forced into App setup.

**App path (multi-tenant):**
1. **Operator, once:** create the App via the manifest flow (`Set up` in the CLI
   config sheet → one click on GitHub generates the App + key, redirects back;
   the hub stores App ID + PEM + OAuth creds in Secrets Manager).
2. **End user, once:** `Connect` in the CLI config sheet → GitHub's "Install &
   pick repositories" screen → redirect back with `installation_id`, stored per
   (tenant, user).
3. **Every clone after:** nothing. The hub auto-mints a fresh token per turn.

## Security gates on connect

- **Signed `state`** (HMAC, `AGENTCORE_STATE_SECRET` or per-process) proves THIS
  user started the install flow — CSRF + session binding.
- **Ownership proof:** the manifest sets `request_oauth_on_install`, so GitHub
  appends an OAuth `code`; we exchange it for a user token and confirm the
  installation is in that user's `/user/installations`. State alone is
  insufficient — during its lifetime a user could swap in another org's
  `installation_id`.
- **Admin proof:** `/user/installations` lists org installs a member can only
  *access*; for an org-account install we additionally require the user's org
  membership role to be `admin`. Fails **closed**: an App with no OAuth creds
  refuses the connect rather than downgrade to state-only binding.
- The manifest-**creation** flow carries its own distinct signed `state`, so an
  admin can't be lured into exchanging an attacker's manifest `code`.

## Config

| Env | Purpose |
|-----|---------|
| `AGENTCORE_STATE_SECRET` | Stable HMAC material for the CSRF `state` (set on multi-instance deploys so state verifies across instances). |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | Dev / single-operator override (skips Secrets Manager). PEM newlines escaped as `\n`. |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | OAuth creds for ownership proof when using the env override. |
| `GITHUB_APP_NAME` | Display name in the manifest (default "AgentCore Hub"). |
| `GITHUB_PAT` | Unchanged personal-deploy fallback (used only when the owner is NOT App-connected). |

The hub's hosting role needs `secretsmanager:GetSecretValue` +
`CreateSecret`/`PutSecretValue` on `cloud-code/github-app*`.

## Files

- `src/lib/cloud-code/github-app.ts` — JWT sign (jose), mint + cache tokens,
  `cloneTokenForUser(tenantId, userId, repo)`, state HMAC, manifest exchange,
  ownership verification.
- `src/lib/cloud-code/github-secrets.ts` — Secrets Manager read/write of the App
  key (env override for dev).
- `src/lib/cloud-code/github-store.ts` — per-(tenant,user) installation record in
  the sessions table (`github:{userId}` for the default tenant, else
  `github:{tenantId}:{userId}`).
- `src/app/api/cloud-code/github/{route,install,callback,manifest}.ts` — status +
  disconnect, install redirect, connect callback, operator manifest flow.
- Turn dispatch: `runtime.ts` (`githubToken`/`githubAppConnected` in the
  payload), `message/route.ts` + `warm/route.ts` mint before invoke.
- Runtime: `main.py::_configure_git(github_token, app_connected)` prefers the
  per-session token; only falls back to `GITHUB_PAT` when the owner is NOT
  App-connected.

## Follow-ups (not in this PR)

- **tmpfs credential helper.** `_configure_git` still writes the token into
  `~/.gitconfig` via `insteadOf` (matching the pre-existing PAT handling), so the
  agent can `cat ~/.gitconfig` and read it. The token is short-lived + repo-scoped
  (small blast radius), but a stricter version would write it to a `/dev/shm`
  file behind a `github.com`-scoped git credential helper and scrub it on a
  token-less turn. Hardens both the App and PAT paths.
- **Rollout:** additive + back-compat. The App path activates only when
  `cloud-code/github-app` is configured AND a user connects; otherwise the
  existing `GITHUB_PAT` path is untouched. No migration.
