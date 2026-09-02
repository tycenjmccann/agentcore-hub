# Blueprint: Review Package

## Your Role (as package author)
A human-review gate follows your phase. The reviewer gets a Telegram ping with
Approve / Request-changes buttons — and today, without your package, that ping
has no context: no scope, no "what am I looking at", and links to random files.
You fix that by writing ONE small JSON file before you `report_completion`.
The pipeline is paused on that human; the quality of your package decides how
fast they can act.

## The contract

Write with `S3Storage___write_object` to:

```
workflows/{workflow_id}/shared/review-package-{gate}.json
```

where `{gate}` is the agent phase the gate follows: `requirements`, `design`,
`ship`, or `redline`. Content type `application/json`.

**Parallel authors (design gate):** designers run concurrently, so NEVER
read-merge-write the shared file — a simultaneous writer would silently erase
your links. Write your OWN file instead:

```
workflows/{workflow_id}/shared/review-package-design.{your_agent_id}.json
```

The hub merges every `review-package-design*.json` when the gate fires. Same
schema; your summary should name your surface ("iOS: tab-based nav with …").

Schema:

```json
{
  "gate": "<requirements|design|ship|redline>",
  "summary": "ONE sentence: what is being approved and why it is ready.",
  "bullets": [
    "3-6 bullets, one line each — scope, key decisions, risks, evidence.",
    "Write for a phone screen. No paragraphs, no filler."
  ],
  "links": [
    { "label": "Requirements doc", "artifactKey": "workflows/{workflow_id}/shared/requirements.md" },
    { "label": "PR #42", "url": "https://github.com/owner/repo/pull/42" }
  ]
}
```

Link rules — this is the part that was broken, follow it exactly:
- Every link must be something the reviewer NEEDS to make the call. If they
  don't need it to decide, leave it out.
- NO duplicates: one link per deliverable, even if the file exists in several
  S3 locations — always link the `shared/` copy.
- `artifactKey` = the full S3 key of an artifact in this run's workspace
  (must start with `workflows/{workflow_id}/`). The hub turns it into a
  tap-to-open viewer link. Use `url` ONLY for external targets (PR, live
  preview). Never put an `s3://` URI in `url` — humans can't open those.
- Order links by review priority: the ONE document to read first goes first.
- 1-4 links. If you think you need more, your package is a table of contents,
  not a review package — consolidate.

If a linked artifact doesn't exist yet, you are not done: save it (or fix the
key) before writing the package. Verify keys with `S3Storage___list_objects`
on `workflows/{workflow_id}/shared/` — a dead link on the reviewer's phone is
worse than no link.

## Per-gate templates

### `requirements` — Spec Approval (reviewer: Product Owner)
The reviewer decides: "is this the right thing to build?"
- summary: the feature in one sentence + who asked for it.
- bullets: what's IN scope, what's explicitly OUT, notable acceptance
  criteria, open questions you resolved by assumption (flag them).
- links: `shared/requirements.md` first. Source material (original request
  doc) only if the spec meaningfully diverges from it.

### `design` — Plan Approval (reviewer: Designer / Engineer)
The reviewer decides: "is this the right way to build it?"
- summary: the approach in one sentence (architecture choice, not restating
  the feature).
- bullets: key design decisions + why, alternatives rejected, riskiest part,
  impact on existing code/UX.
- links: your design doc first, then your visual deliverables (mockup
  HTML/PNG, architecture diagram). Only YOUR surface's links — each designer
  writes their own `review-package-design.{your_agent_id}.json` (see Parallel
  authors above); the hub merges them into one package at gate time.

### `ship` — Merge Approval (reviewer: Code Owner)
The reviewer decides: "does this merge and deploy?"
- summary: what the PR does + verdict basis ("review PASS, QA PASS, CI green").
- bullets: what changed (component-level, not file-level), test/QA evidence
  (counts, not adjectives), anything the reviewer should look at extra hard,
  deploy impact (migrations, env vars, flags).
- links: the PR url FIRST (that's the review surface), then
  `shared/ship-review-summary.md`. Do not link intermediate dev artifacts —
  the PR diff supersedes them.

### `redline` — Counsel Sign-off (reviewer: Legal)
The reviewer decides: "do these redlines go to the counterparty?"
- summary: contract type + counterparty + overall risk posture in one line.
- bullets: highest-risk terms and how each redline resolves them, fallback
  positions included, anything you could NOT resolve (needs counsel judgment
  — flag explicitly).
- links: `shared/redlines.md` first, then the original contract source, then
  at most one supporting review (`contract-review.md`) if counsel will need
  the reasoning.

## What good looks like

```json
{
  "gate": "ship",
  "summary": "Adds review-gate context packages: PR #162 wires curated links into approval pings — review PASS, QA PASS, CI green.",
  "bullets": [
    "Scope: orchestrator notification builder, Telegram gate ping, 7 blueprints",
    "No schema migration — new notification fields are optional, old pings still render",
    "Riskiest change: gate ping now reads S3 at notify time (fallback to thin ping on miss)",
    "QA: 12 new unit tests, e2e gate ping verified against staging bot"
  ],
  "links": [
    { "label": "PR #162", "url": "https://github.com/acme/hub/pull/162" },
    { "label": "Ship review summary", "artifactKey": "workflows/wf_123/shared/ship-review-summary.md" }
  ]
}
```

Anti-patterns (all real, all why this blueprint exists):
- Linking 3 files that are the same document in 3 places.
- Bullets that restate the ticket title instead of the decision evidence.
- "Various improvements" — the reviewer cannot approve "various".
- Writing the package but linking your agent workspace copy instead of
  `shared/` (reviewer gets a 404-equivalent).
