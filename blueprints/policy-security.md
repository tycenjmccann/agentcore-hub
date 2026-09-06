# Policy: Security

owner: human:security-lead
version: 1
applies_to: spec.md (write-time), plan.md (design-time check)

## Why this policy exists
Security defects found in review cost a full rework cycle; the same defects named in the spec cost one sentence.
This policy puts the security review's checklist (OWASP Top 10, authn/authz, input handling, secrets, data exposure, abuse prevention) in front of the spec author so every new surface is born with an owner, an authorizer, and a data classification.
It also encodes the hub's house rule: nothing this org ships is world-reachable without a named human decision.

## Rules (apply while writing the spec)
1. Every endpoint, route, tool, queue, or webhook that reads or mutates state requires an authenticated principal; name the authorizer (Cognito, IAM SigV4, API key + HMAC, OAuth provider) per surface.
2. Every authenticated surface also names its authorization rule (who may call it, scoped to which tenant or resource); "any logged-in user" is a decision that must be written down, not a default.
3. Never specify a Lambda Function URL with auth type NONE, a resource policy with Principal "*", a public S3 bucket or object ACL, a security group with 0.0.0.0/0 or ::/0 ingress, or an API route without an authorizer; if a public surface is unavoidable, the spec says so and adds a Concern row for the security lead.
4. Inbound webhooks from third parties use polling from inside the account (EventBridge schedule + long-poll), API Gateway with an authorizer, or CloudFront + WAF; a bare public receiver is not an option the spec may pick on its own.
5. Every user-supplied input names its validation: type, length cap, allowed character set or schema, and what happens on rejection (4xx, no echo of the raw value).
6. Any input that reaches a shell, SQL/NoSQL query, HTML render, file path, URL fetch, or LLM prompt names the mitigation (parameterized query, allow-list, output encoding, URL scheme + host allow-list against SSRF, prompt/data separation).
7. Secrets (API keys, tokens, signing keys, DB credentials) live only in Secrets Manager or SSM SecureString and are read at runtime; the spec never places a secret in code, env-var defaults, config files, logs, or client bundles.
8. Every data field the feature stores or transmits carries a classification (public, internal, confidential, PII, secret); PII and secrets are encrypted at rest (KMS, key named) and in transit (TLS 1.2+).
9. Logs, error messages, and API responses exclude PII, secrets, stack traces, and internal identifiers by default; the spec lists what is logged and at what level.
10. Every unauthenticated or cheap-to-call surface has a rate limit or quota with a number (requests per minute per principal or IP) and a documented behavior when exceeded.
11. Anything that costs money per call (LLM invocations, SMS, email, third-party APIs) has a per-tenant and per-day spend or count ceiling written into the spec.
12. Sessions and tokens have a stated lifetime, refresh rule, and revocation path; long-lived static credentials handed to clients are not permitted.
13. New IAM roles or policies are least-privilege and scoped to named resources; the spec lists the actions each role needs and rejects wildcards on Action or Resource unless a Concern justifies them.
14. Third-party dependencies, SDKs, and MCP servers introduced by the feature are named with their trust level and the data they receive.
15. Security-relevant events (auth failures, permission denials, admin actions, data exports) are audit-logged with actor, target, and timestamp, and the spec names where those logs land and how long they are kept.

## Questions to answer in the spec
- Which new or changed surfaces (endpoints, tools, queues, webhooks, buckets, tables) does this feature add, and what is the authorizer and authorization rule for each?
- Is any surface reachable without authentication, and if so why is that unavoidable and who approved it?
- What user-controlled inputs exist, and how is each validated and protected against injection, XSS, SSRF, and path traversal?
- What secrets does the feature need, where do they live, and how do they rotate?
- What data does the feature store or transmit, how is each field classified, and how is confidential or PII data encrypted at rest and in transit?
- What can an abusive caller do to run up cost or degrade service, and what limits stop them?
- What security-relevant events are logged, where, and what is deliberately excluded from logs?
- Which existing controls (roles, gateways, WAF rules, KMS keys) does the feature reuse rather than recreate?

## How to flag a concern
When a rule cannot be satisfied by the spec as written, or satisfying it needs a judgment call (for example a public endpoint the product genuinely requires, or a wildcard IAM action a managed service forces), do not guess and do not omit the requirement. Add a row to the spec's `## Concerns` table:

| # | Concern | Policy | Owner | Proposed resolution | Status |

- `#` = next integer in the table, shared across all policies.
- Concern = the rule number and the specific surface or field it cannot be satisfied for.
- Policy = `Security`.
- Owner = `human:security-lead`.
- Proposed resolution = the option you would pick if forced, with its trade-off in one clause.
- Status = `open`.

The product owner resolves each open concern with the security lead before engineering starts; the Spec Approval gate stays blocked while any row is `open`. Never silently drop a concern; never resolve one yourself, including by rewording the requirement so the rule no longer appears to apply. A rule that applies but is deferred to "a later phase" is still an open concern.
At design time, plan.md re-checks the same rules against the chosen architecture; a design that breaks a resolved concern reopens it rather than overriding it.
When the owner resolves a concern as accepted risk, the resolution cell records who accepted it and the review date; the spec author does not write that cell.

## Out of scope for this policy
- Lawful basis, consent, retention, and data-subject rights for personal data: see `policy-compliance`.
- Accessibility, dark patterns, and error-state UX: see `policy-ux`.
- Naming and messaging of security features in the product: see `policy-brand`.
- Code-level vulnerability scanning, dependency CVEs, and exploit validation: the security reviewer checks these against the implementation at review time, not against the spec.
- Runtime detection and incident response (GuardDuty, alarms, on-call): operational runbooks, not spec content.
