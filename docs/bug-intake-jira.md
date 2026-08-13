# Bug Intake (Jira mode)

**THE canonical way to feed externally-discovered bugs into the workflow pipeline
when `TICKET_PROVIDER=jira`.** No `/api/workflow/start` call, no workflow row to
pre-create, no new MCP server, no polling. You create a Jira **Bug** issue; the
hub does the rest.

> This path exists **only** in Jira mode. In DynamoDB mode, workflows are created
> exclusively through `POST /api/workflow/start` (see
> [`workflow-pipeline-architecture.md`](workflow-pipeline-architecture.md)).

---

## The flow

```
Your bug source (any system)
        │  create a Jira issue: type=Bug, no parent, labels below
        ▼
Jira project webhook  ──jira:issue_created──►  /api/jira/webhook
        │                                            │ invokes orchestrator (source:"jira-webhook")
        ▼                                            ▼
                              orchestrator: status "todo" + issueType=="Bug"
                              + no parentId + no workflowId  →  bootstrapBugWorkflow()
        │
        ├─ creates the workflow row   (epicId = the Bug's key)
        ├─ labels the Bug  wf:<id> + agentcore-hub-workflow
        └─ creates a requirements-analyst sub-task → transitions it "Ready"
                                                            │
                                                            ▼
                        Ready webhook → orchestrator → invokes analyst
                        → analyst builds the Fix → QA → CI sub-task chain
                        → pipeline runs → opens a PR against the ticket's repo
```

The **Bug issue itself is the workflow root** — there is no separate Epic wrapper.
`bootstrapBugWorkflow` is idempotent (keyed on the Bug's issue key via
`epicId-index`), so redelivered webhooks won't double-provision.

### Trigger conditions (all must hold)

| Condition | Why |
| --- | --- |
| `TICKET_PROVIDER=jira` | This is the Jira-only bootstrap path. |
| `issueType == "Bug"` | Distinguishes an intake root from ordinary pipeline sub-tasks. |
| no `parentId` | A Bug under a parent is treated as pipeline work, not a new root. |
| no `workflowId` label | Already-provisioned bugs are skipped. |

---

## Bug ticket shape

Create the issue in the project the webhook is filtered to
(`JIRA_PROJECT_KEY`), with:

| Field | Value | Required |
| --- | --- | --- |
| Issue Type | `Bug` | ✅ |
| Parent | *(none)* | ✅ must be empty |
| Summary | short bug title | ✅ |
| Description | repro / stack / expected vs actual | recommended |
| Label | `repo:<owner>/<name>` — target GitHub repo | ✅ (unless `DEFAULT_BUG_REPO_URL` set) |
| Label | `branch:<name>` — base branch | optional (default `main`) |

### Why the repo rides on the ticket

One hub serves bugs across **many** repos. The target repo travels **on the Bug**
as a `repo:owner/name` label, so nothing is hardcoded and no per-repo config is
needed. `bootstrapBugWorkflow` reads it into the workflow's `repoConfig`, which
flows through branch creation, PR opening, and agent context automatically.

- **Multi-repo (recommended):** put `repo:owner/name` on every Bug.
- **Single-repo shortcut:** set env `DEFAULT_BUG_REPO_URL` (and optionally
  `DEFAULT_BUG_REPO_BRANCH`) on the orchestrator Lambda; then the label is optional.
- **Neither present:** the hub does **not** guess. It skips bootstrap and posts a
  Jira comment asking for a `repo:` label. (Fail loud > wrong-repo PR.)

### Example (Jira REST — create a Bug)

```bash
curl -sf -X POST "https://${JIRA_SITE_URL}/rest/api/3/issue" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "project":   { "key": "TEAM" },
      "issuetype": { "name": "Bug" },
      "summary":   "Checkout throws 500 when coupon is expired",
      "labels":    ["repo:acme/checkout-api", "branch:main"],
      "description": {
        "type": "doc", "version": 1,
        "content": [{ "type": "paragraph", "content": [
          { "type": "text", "text": "Steps: apply an expired coupon at /cart → 500. Expected: 400 with COUPON_EXPIRED. Stack: ..." }
        ]}]
      }
    }
  }'
```

That single call kicks off the entire pipeline. You do **not** transition the Bug
yourself — `bootstrapBugWorkflow` provisions and drives it.

---

## Prerequisites

- The project webhook must be registered (fires `jira:issue_created` /
  `jira:issue_updated`, filtered to `JIRA_PROJECT_KEY`). See
  `deploy/apprunner/setup-jira-webhook.sh`.
- Orchestrator Lambda env: `TICKET_PROVIDER=jira`, `JIRA_SITE_URL`,
  `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`. Optionally
  `DEFAULT_BUG_REPO_URL` for the single-repo shortcut.
- Your Jira project needs a **Ready** status/transition (the pipeline routes
  work by transitioning to Ready).

## Integrating an external bug source

Anything that can make an authenticated Jira REST call can feed the pipeline —
a webhook receiver, a cron job, a DynamoDB Streams handler on your own bug table,
etc. The integration's only job is: **create a Jira Bug with the labels above.**
A reference AWS Lambda (DynamoDB Streams → create Jira Bug) is provided as a
template — see the deployment guide for your environment; it is intentionally
kept out of this OSS repo because it is account/table-specific.

## Retrying a skipped bug

If bootstrap was skipped (missing/invalid repo label), fix the label on the Bug,
then **transition it to any other status and back to "To Do"**. That status
change re-fires the webhook, which re-runs bootstrap (idempotent — it will not
create a second workflow if one already exists). Simply editing the label does
**not** retry: `issue_updated` events without a status change are ignored.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing happens after creating the Bug | Webhook not registered, or issue created outside `JIRA_PROJECT_KEY`. |
| Log: "no target repo" + Jira comment asking for `repo:` label | No `repo:owner/name` label and no `DEFAULT_BUG_REPO_URL`. Add the label and retry (see above). |
| Log: "malformed repo label" + Jira comment | A `repo:` label is present but not exactly `owner/name` (e.g. an extra path segment). An invalid explicit label is **never** silently replaced by `DEFAULT_BUG_REPO_URL` — fix the label and retry. |
| Bug created but no sub-task | Bug had a parent, or a `wf:` label already — bootstrap only fires for a bare top-level Bug. |
| PR opened on the wrong repo | `repo:` label points at the wrong (but valid) slug. A malformed label fails loud rather than falling back. |
