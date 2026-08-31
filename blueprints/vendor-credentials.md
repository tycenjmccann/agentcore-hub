# Vendor credentials — where keys live, and how to preflight access

Any work that talks to a live third-party service (ElevenLabs, Stripe, Plaid,
OpenAI, a vendor console, a hosted-agent config push) needs that vendor's API
key or token at runtime. The #1 way this class of work stalls for a day: the
code finds the right secret NAME, but the runtime role cannot READ it, and the
agent discovers this halfway through and either dies silently or parks with no
actionable escalation. This blueprint is the convention plus the preflight that
turns that silent day-long stall into an instant, fixable BLOCKED.

## The convention: one hub-owned namespace, no cross-account reach

- Every vendor credential this pipeline needs lives in the **hub prod account**
  ({account}), under a predictable name: **`hub/{app}/{vendor}-key`**
  (e.g. `hub/juno/elevenlabs-key`). Region matches where the consumer runs
  (usually `us-west-2` for voice/agent config, else the app's region).
- **Do NOT reach into another account for a secret.** These accounts run a
  strict cross-account policy; a coding-runtime role granted GetSecretValue on
  a secret in a different account is both blocked in practice and the wrong
  security posture. If the canonical secret lives in another account you own,
  the fix is to **mirror the value into the hub account** under the name above
  and point the code at the in-account name — never a cross-account ARN.
- Access is **per-secret, least-privilege**: the runtime role gets
  `GetSecretValue` + `DescribeSecret` on that ONE secret ARN
  (`arn:aws:secretsmanager:{region}:{account}:secret:hub/{app}/{vendor}-key-*`),
  never a wildcard over all secrets, never a god-role.
- **Never print or commit a secret value.** Names and ARNs only.

## Preflight — BEFORE you build or run the step that needs the key

Existence is not access. Do BOTH, in order, and stop at the first failure:

1. **Name check** — confirm the exact secret name the code reads exists (you may
   already do this in the external-API step). Wrong/missing name → fix the name
   or file it.
2. **Read check** — confirm THIS runtime can actually read it. Probe with
   `GetSecretValue` from inside the runtime (your `claude_code`/`codex`
   specialist can run the AWS CLI, or the code's own load path) — but the
   default CLI output prints the decrypted `SecretString` into the tool
   transcript, which violates the never-print rule even on success. Always
   select non-secret fields only:
   `aws secretsmanager get-secret-value --secret-id <name> --query '{arn:ARN,version:VersionId}' --output json`
   (`DescribeSecret` alone is NOT a read check — it needs no `GetSecretValue`
   permission, so it can pass while the real read is denied.) `AccessDenied`
   here is the trap — it means the role lacks the grant, and no retry will
   fix it.

If the read check fails with AccessDenied (or the secret is absent and you own
the value elsewhere), **STOP and report BLOCKED** — do not limp forward, do not
`report_completion`. Emit the exact, copy-pasteable fix so a human clears it in
two minutes:

```
BLOCKED: vendor credential not readable by the runtime.
  secret needed : hub/{app}/{vendor}-key   (region {region})
  read by role  : agentcore-hub-coding-runtime-role
  failure       : secretsmanager:GetSecretValue -> AccessDenied
  fix (one-time, in account {account}):
    # if the value only exists in another account you own, mirror it in first:
    aws secretsmanager create-secret --region {region} \
      --name hub/{app}/{vendor}-key --secret-string '<value from owning account>'
    # then scope the grant to just this secret ARN:
    aws iam put-role-policy --role-name agentcore-hub-coding-runtime-role \
      --policy-name {App}{Vendor}SecretRead --policy-document '{
        "Version":"2012-10-17","Statement":[{"Effect":"Allow",
        "Action":["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],
        "Resource":"arn:aws:secretsmanager:{region}:{account}:secret:hub/{app}/{vendor}-key-*"}]}'
  after the grant: re-run this ticket (the coding session is resumable).
```

This is a real authorization decision — a human makes it once per app+vendor,
then every future run just works. Your job is to make that decision instant and
obvious, not to silently absorb the failure.

## Declare it so the next run preflights automatically

When you touch a repo whose deploy/config step needs a vendor key, add (or
confirm) a **Required credentials** line in that repo's `DEPLOY.md`:

```
## Required credentials
- hub/juno/elevenlabs-key (us-west-2) — read by agentcore-hub-coding-runtime-role
```

The next agent reads DEPLOY.md, preflights those secrets up front, and escalates
before doing any work if a grant is missing — instead of discovering it at
minute 13.

## Sanity check

- [ ] Secret lives in the hub account under `hub/{app}/{vendor}-key` — not a
      cross-account ARN.
- [ ] I confirmed the runtime can READ it, not just that it exists.
- [ ] AccessDenied → I reported BLOCKED with the exact create+grant commands,
      and did NOT report_completion.
- [ ] The grant is scoped to that one secret ARN, not a wildcard.
- [ ] The repo's DEPLOY.md lists the required credential(s).
