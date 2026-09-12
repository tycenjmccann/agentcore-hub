# Coding Agent Runtime (resumable Claude Code + Codex + Kiro)

A dedicated Amazon Bedrock AgentCore Runtime that hosts coding CLIs server-side
with a **persistent per-session workspace** (`/mnt/efs`) and **OTel →
CloudWatch tracing**. This is the official "safe to close your laptop" pattern
from [awslabs/agentcore-samples](https://github.com/awslabs/agentcore-samples)
(`04-coding-agents/01-claude-code-with-s3-files`): the CLI runs in a per-session
microVM, the workspace survives, and you **resume a conversation by invoking
again with the same `runtimeSessionId`**.

> This is a standalone, user-facing coding agent — NOT wired into the 16-agent
> workflow fleet. (An earlier attempt to force coding-CLI output through the
> workflow pipeline failed because the pipeline assumes local files; this model
> is Git-native and conversational instead.)

## Interaction model

```
client ── invoke_agent_runtime(runtimeSessionId, {prompt, repo?, cli?, claude_session_id?})
          │
          ▼
   microVM (one per runtimeSessionId)
     main.py /invocations
       ├─ git clone repo → /mnt/efs/sessions/<id>        (first turn only; warm after)
       ├─ claude --print --resume <claude_session_id>    (or run-codex.sh for codex)
       └─ commit / push / open PR
     ← { response, claude_session_id, cli, workspace }

resume = same runtimeSessionId  → same warm microVM + /mnt/efs
       + claude_session_id       → same Claude Code conversation
```

- **Workspace persistence:** an EFS access point mounted at `/mnt/efs`
  (`WORKSPACE_ROOT`), shared by every session microVM; each session checks out
  under `/mnt/efs/sessions/<id>`. A re-invoke with the same session id finds the
  repo already cloned.
- **Dependencies are provisioned, never installed per session.** At workspace
  setup `main.py` (`_provision_deps`) hashes the checkout's `package-lock.json`
  and makes `node_modules` a **symlink** to a per-microVM copy under `/tmp/deps/
  <lockhash>/`, extracted once from the shared EFS tarball
  `/mnt/efs/.deps/<lockhash>.tar`. The first session ever to see a lock runs the
  one `npm ci` (on local disk), publishes the tarball, and keeps its copy; every
  later VM just unpacks (~700 MB sequential read, seconds). No local room →
  the tarball is unpacked once into `.deps/<lockhash>/` on EFS and linked from
  there. A `post-checkout` hook makes every `git worktree add` inherit the link,
  and `node_modules` goes into `.git/info/exclude` (the `node_modules/`
  gitignore rule does not match a symlink). Before this, each session's CLI ran
  `npm ci` on EFS (3-8 min over NFS, again per worktree) — 50-75% of a coding
  turn's wall clock. Not baked into the image: AgentCore caps runtime images at
  2 GB and this one is ~1.85 GB. Kill switch: `WORKSPACE_DEPS_ENABLED=0`. A
  `warm` call reports `deps` (`local` / `efs_tar` / `efs` / `built` / `linked` /
  `present` / `skipped` / `unavailable`).
- **Codex state DBs live off EFS.** `CODEX_HOME=/mnt/efs/.codex` holds the
  transcripts (`sessions/**/rollout-*.jsonl`) and `config.toml`, but Codex's
  SQLite state/log DBs are WAL-mode and WAL across NFS clients corrupts them
  ("file is not a database" + a repair prompt on every start). `CODEX_SQLITE_HOME`
  therefore defaults to container-local `/tmp/codex-sqlite` (Dockerfile ENV,
  `run-codex.sh`, `shell-init.sh`, `main.py`). `codex resume <id>` falls back to
  the rollout files when the DB is fresh, so resume is unaffected.
- **Conversation resume:** Claude Code's own `--resume <session_id>`. Claude scopes
  a conversation to its working directory, so the server persists a
  `{claude_session_id → repo}` map (`/mnt/efs/.sessions.json`) and recovers
  the cwd automatically — the caller only needs to pass `claude_session_id`.
- **Git-native:** works from a clone, not your local files. Output = a pushed branch / PR.

## Files

| File | Role |
|---|---|
| `main.py` | Resumable `/invocations` FastAPI server + `/ping` health (HealthyBusy while a CLI runs) |
| `run-codex.sh` | Codex launcher — routes GPT-5.5 through Bedrock Mantle (no OpenAI key) |
| `Dockerfile` | ARM64 image: git, Node/npx, **uv/uvx**, pip, **headless chromium**, Claude Code, Codex, **Kiro CLI**, otelcol-contrib. Carries the MCP launchers (not specific servers) so a user's synced servers self-install |
| `otel-collector-config.yaml` | SigV4 OTLP → CloudWatch `aws/spans` |
| `setup-coding-runtime-role.sh` | IAM execution role (Bedrock + Mantle + ECR + observability) |
| `build-and-push.sh` | Build/push ARM64 image to ECR (account/region from `config.sh`) |
| `deploy.py` | Create/update the runtime via the control API (session storage) |
| `deploy-instances.py` | Create/update/`--delete` the **Instances twin** (`agentcore_hub_coding_runtime_ec2`): EC2 capacity provider + EBS-per-session, copied from the microVM runtime |
| `probe-instances.py` | Go/no-go probe for the Instances twin (`cold`/`pin`/`fs`/`turn`/`persist`/`cleanup`/`show`) |
| `invoke.py` | Headless client to fire/resume turns |
| `log.py` | Structured JSON logging |

## Deploy

```bash
export AWS_PROFILE=<your-profile>
set -a; source .env.local; set +a          # GITHUB_PAT, GITHUB_OWNER
source deploy/config.sh

source deploy/coding-agent-runtime/setup-coding-runtime-role.sh   # → CODING_RUNTIME_ROLE_ARN
./deploy/coding-agent-runtime/build-and-push.sh                   # → IMAGE_URI
export IMAGE_URI=<account>.dkr.ecr.<region>.amazonaws.com/coding-agent-runtime:latest
python3 deploy/coding-agent-runtime/deploy.py                     # → CODING_AGENT_RUNTIME_ARN
```

## Use (headless)

```bash
export CODING_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:...:runtime/...

# New session on a repo:
python3 deploy/coding-agent-runtime/invoke.py --repo owner/name \
  "add a CONTRIBUTING.md, commit on a new branch, push, open a PR"

# Resume (same workspace + conversation) — only need the two ids it printed:
python3 deploy/coding-agent-runtime/invoke.py \
  --session <runtimeSessionId> --resume <claude_session_id> "now add a license section"

# Codex (GPT-5.5 via Bedrock Mantle) instead of Claude:
python3 deploy/coding-agent-runtime/invoke.py --cli codex --repo owner/name "..."

# Kiro (bring-your-own-key — requires KIRO_API_KEY on the runtime, no Bedrock fallback):
python3 deploy/coding-agent-runtime/invoke.py --cli kiro --repo owner/name "..."
```

## Payload contract

`POST /invocations` (via `invoke_agent_runtime`):

| Field | Required | Notes |
|---|---|---|
| `prompt` | yes* | The task / message for this turn (*not required when `warm` or `checkpoint`) |
| `repo` | no | `owner/name` or clone URL. Cloned on first turn; recovered from the session map on resume |
| `cli` | no | `claude` (default), `codex`, or `kiro` |
| `claude_session_id` | no | From a prior turn's response → resumes that Claude Code conversation |
| `session_id` | no | runtimeSessionId — isolates this session's checkout under `/mnt/efs/sessions/<id>` |
| `stream` | no | `true` → SSE token/step stream (claude, codex, kiro) |
| `branch` | no | `git fetch + checkout` this branch before the turn (the ported in-flight branch) |
| `resume_transcript` | no | S3 key of a ported `.jsonl`. Installed at the cwd slug → native `claude --resume` |
| `resume_session_id` | no | The conversation id inside that transcript (its filename) |
| `warm` | no | Setup-only: clone + checkout + install transcript, **no CLI run**. Pre-warms the microVM at port time. Pass `user_id`+`config_version` so it also materializes the config bundle |
| `prepare` | no | Config-only: materialize the user's bundle (skills/agents/`.mcp.json`) + default MCP, then return. No clone, no CLI. Fired by `/shell` so a terminal-only session gets the user's tools without a chat turn. Needs `user_id`+`config_version` |
| `checkpoint` | no | Upload the grown transcript back to S3 (the return leg). Returns `{key, bytes, branch}` |
| `mode` | no | `async` → ack with a `turn_id` and run the CLI on a background thread (how fleet personas call in; see below) |
| `turn_id` | no | Caller-generated id for an `async` submit. Makes submission idempotent: a resubmit of the same id is acknowledged, never run twice |
| `turn_timeout_secs` | no | Per-turn wall-clock cap for the CLI (the orchestrator resolves it per agent). Falls back to the runtime's own default |
| `action: "poll"` | no | Legacy status read for an `async` turn. Rollback shim only — current callers wait via the command API |

Response: `{ response, claude_session_id, cli, workspace }`, or for the
setup-only modes `{ warmed, workspace }` / `{ checkpointed, key, bytes, branch }`,
or `{ error }`. An `async` submit answers `{ submitted, turn_id, workspace, turn_dir }`.

### Async turns: how a caller learns the outcome

The platform kills any invocation whose response is silent for 15 minutes, and
coding turns are routinely silent for longer, so a fleet persona cannot hold the
connection open. It submits with `mode:"async"` and gets a `turn_id` in seconds.

The turn's state lives on **this microVM's own disk**, never on the shared
filesystem (`TURNS_ROOT`, default `/tmp/turns/<turn_id>/`):

| File | Written | Holds |
|---|---|---|
| `meta.json` | at submit, before workspace setup | cli, session, cap, phase |
| `pid` | right after `Popen` | the CLI's pid, which is also its process-group id |
| `stderr.log` | by the CLI | stderr (a file, not a pipe: a grandchild that outlives a kill would otherwise keep the pipe open and block the reader forever) |
| `done.json` | once, when the turn ends | the terminal record: `response`, `claude_session_id`, `artifacts`, `error` |

The caller then waits by running a short shell probe **inside this container** via
`InvokeAgentRuntimeCommand`, which runs concurrently with the in-flight
invocation. The probe reports `done` / `missing` / `starting` / `running` /
`exited_no_done` and returns as soon as `done.json` appears. There is no
heartbeat: liveness is the CLI process itself, read from `/proc/<pid>/stat`. A
runner that outlives `turn_timeout_secs + TURN_RUNNER_GRACE_S` writes its own
terminal record, so a wedged turn can never leave the session `session_busy`.

See DL-026 in [docs/architecture.md](../../docs/architecture.md)
for why the earlier EFS-journal + poll design was replaced.

### Port / pull round trip

The hub MCP's cloud-code tools (see [mcp/hub](../../mcp/hub/README.md))
drives this for a laptop↔cloud handoff:
- **port** ships the raw transcript to `s3://<bucket>/cloud-code/resume/<sid>/…`,
  then `warm` pre-clones; the first turn passes `resume_transcript` + `branch` for
  a lossless `claude --resume`.
- **pull** calls `checkpoint` → the runtime uploads the now-grown transcript to
  `…/cloud-code/checkpoint/<sid>/…`; the laptop downloads it and resumes locally.
- Slug rule (must match Claude's): `re.sub(r'[^a-zA-Z0-9]','-', realpath(cwd))`.

## Instances (EC2 + EBS) twin

`deploy-instances.py` stands the same image up a second time on the AgentCore
**Instances** compute type: an EC2 capacity provider (`agentcore_hub_coding_cp`,
m7g.xlarge, coding VPC private subnets + existing SG, operator role with
`BedrockAgentCoreRuntimeInstancesOperatorRolePolicy`) and runtime
`agentcore_hub_coding_runtime_ec2` whose sessions each get one persistent gp3
EBS volume (30 GiB, encrypted) mounted at `/mnt/workspace`. Image, execution
role and env are copied from the microVM runtime (`/mnt/efs` paths rewritten,
`WORKSPACE_MIRROR_ENABLED=0`). Idempotent create/update; `--delete` removes the
runtime, then the capacity provider and every session/volume. Knobs are env
vars documented in the script docstring (`CODING_INSTANCE_TYPES`,
`CODING_VOLUME_GIB`, `CODING_VOLUME_SNAPSHOT_ID`, `CODING_IDLE_S`,
`CODING_MAX_LIFETIME_S`, ...). Needs boto3 ≥ 1.43.9x — run from a venv if the
system one is older.

Why: measured on prod, `npm ci` 13 s vs 20-30 min on EFS, `tsc` 5 s vs 30-95 s,
2 000 small-file creates 0.07 s vs 22.5 s (317x). Cold session (EC2 launch +
image pull) p95 ~114 s; warm invoke 0.4 s; `StopRuntimeSession` → re-invoke
5.5 s with the tree intact; idle-timeout re-attach lands on a new instance with
the same volume (~85 s). The EFS mirror / deps-tarball tiers are not ported —
they buy < 90 s per fresh session here. Seed the volume from a snapshot
(`CODING_VOLUME_SNAPSHOT_ID`) if first-turn latency ever matters.

Gotchas: the volume root is `nobody:agentcore-runtime-user` (setgid) — only
`main.py` (PID 1) carries that group, so the command shell can only write under
`sessions/`; the image has no `sudo`/`bc`. A stopped session's volume still
bills until `DeleteCapacityProviderSession` — the session reaper's sweep does
that (below).

`probe-instances.py <phase>` measures each gate in isolation (`cold --n 5`,
`pin`, `fs`, `turn --repo owner/name`, `persist`, `cleanup`, `show`); state
under `.local-workspace/`. Always finish with `cleanup`.

**Cutover** = env flip, not a redeploy: both runtimes stay up, every
coding-session row records the `runtimeArn` it was minted on, and the fleet /
hub read `CODING_AGENT_RUNTIME_ARN` to pick where *new* sessions go.
```bash
B="$(cat deploy/coding-agent-runtime/coding-runtime-instances-arn.txt)"
python3 deploy/runtime-agent/set-runtime-env.py agentcore_hub_agent CODING_AGENT_RUNTIME_ARN="$B"   # fleet
./deploy/ecs-express/set-env.sh CODING_AGENT_RUNTIME_ARN="$B"                                        # hub
```
Rollback = the same two commands with the microVM ARN. Rework on a session
from the other runtime (or one whose compute was released) starts a fresh
session instead of resuming.

**Cleanup** — `deploy/session-reaper` sweep (EventBridge, 15 min): for every
session row without `computeReleasedAt` whose workflow is finished (past a
grace: 30 min Instances / 6 h EFS), whose workflow row is gone > 24 h, or a
human Instances session idle > 14 d, it calls `DeleteCapacityProviderSession`
(Instances) or stop + `purge` (EFS), picking the path from the runtime's
`capacityProviderConfiguration`, and stamps `computeReleasedAt` /
`computeRelease` / `computeReleaseReason`. Caps 100 CP / 20 purge per tick;
`{"sweep":true,"dry_run":true}` plans without acting; fails closed if boto3
lacks the capacity-provider API. CD swaps the coding image digest into both
runtimes (`capacityProviderConfiguration` preserved).

## Session storage GC

`sessions/<id>/` never gets cleaned up by the CLI — a TTL sweep in
`_gc_stale_sessions()` runs off the turn path (opportunistic, at most once per
warm microVM per 6h) and considers two candidate classes:

- **Marker class (always on):** dirs stamped `.workflow-session` — written only
  when a turn arrives with `origin:"workflow"` (the fleet). Staleness = marker
  mtime older than `SESSION_TTL_DAYS` (default 14). Human Cloud Code sessions
  never carry this marker and are never touched by this class.
- **Unmarked class (`SESSION_GC_UNMARKED`, default `dry-run`):** dirs with NO
  marker at all. Most session dirs predate the marker or came from an aborted
  setup, so without this class the volume grows unbounded (~640 dirs / ~330 GB
  and climbing as of TEAM-4418). There is no positive "this is a human
  session" signal anywhere in this system, so this class is conservative by
  construction:
  - `dry-run` (default) — logs `session_gc_unmarked_candidates` once per
    sweep (count, oldest age in days, up to 20 example dir names) and deletes
    nothing.
  - `enforce` — `rmtree`s the candidates (oldest-first, capped by
    `SESSION_GC_MAX_DELETES`, default 100 per sweep) and logs
    `session_gc_unmarked_removed`.
  - `off` — skips the class entirely; the marker class is unaffected in every
    mode.

  Staleness = last activity older than `SESSION_TTL_DAYS`, where last activity
  is the max mtime of the dir itself, its `.session-meta.json` /
  `.resume-installed` / `.workflow-session` files (whichever exist), and the
  mtimes of its **top-level** entries from one `os.scandir` — never a
  recursive walk (EFS walks are too slow for a turn path), so a fresh file
  buried deep in a checkout does not keep a dir alive.

  A dir is never a candidate if it is running on this VM (`_ACTIVE_TURNS`), is
  outside `sessions/`, is one of the shared roots (`.mirrors`, `.deps`,
  `.claude-data`, `.codex`, `.kiro-data`), is a symlink, carries a laptop
  port/pull artifact (`.bundle-applied`/`.return.bundle`), or is named in
  `.sessions.json` (the human/CLI conversation-id map — an over-matching,
  conservative spare, not a real human signal).

  Before flipping to `enforce` on a runtime, read a few sweeps of
  `session_gc_unmarked_candidates` in CloudWatch to confirm the example names
  really are disposable.

## Verified

- Invoke loop, conversation resume (remembers prior turns), clone→edit→commit→push→**real PR**,
  warm `/mnt/workspace` across invokes with auto-recovered cwd, and Codex (GPT-5.5/Mantle) — all green.

## Streaming

Claude turns stream token-by-token over SSE. `/invocations` with `stream:true`
runs `claude --output-format stream-json --include-partial-messages` and the
server returns a `StreamingResponse` of `data:` frames (`{type:text|done|error}`)
that AgentCore forwards through `InvokeAgentRuntime` (accept `text/event-stream`).
The Next.js chat consumes it via the shared SSE reader. See
[docs/streaming-sse.md](../../docs/streaming-sse.md). Codex and Kiro stream too:
`stream:true` with `cli:codex` / `cli:kiro` emits the same
`{type:text|done|error}` SSE frames — step-level, from codex `exec --json`
events and kiro's stdout lines — so every CLI streams live in the UI.

## Kiro notes
- **Auth is bring-your-own-key ONLY** — set `KIRO_API_KEY` (ksk_… from kiro.dev) in
  `.env.local` before `deploy.py`; there is no Bedrock fallback, and without the key
  every kiro turn fails fast with "KIRO_API_KEY not set".
- **Model:** `KIRO_MODEL` defaults to `auto` (kiro's server-side routing). Set a
  specific model id to pin.
- **Resume:** full conversation resume via `kiro-cli chat --resume-id` — the returned
  `claude_session_id` field carries the kiro conversation uuid (CLI-agnostic handle).
- **Billing:** kiro meters credits, not tokens. The per-turn credits footer is parsed
  into structured `coding_usage` log records for the cost-report Lambda.

## Known gaps / next
- **Single-user:** no auth yet. Session records should carry `userId` (hardcode `"default"` now,
  swap for the Cognito `sub` when app-wide SSO lands).

### Deps cache knobs

| Env | Default | Meaning |
|---|---|---|
| `WORKSPACE_DEPS_ENABLED` | `1` | `0` = no provisioning, no post-checkout hook (pre-#515 behaviour) |
| `DEPS_LOCAL_KEEP` | `2` | Per-VM extracted copies to keep (~1.2 GB each against ~4.3 GB local). Oldest beyond this are evicted on every provision; the current lockfile and any copy a live checkout links to are never evicted. `0` disables eviction. |
| `DEPS_TAR_TTL_S` | `2592000` | EFS tarballs untouched for this long are swept on the next publish |

A `node_modules` that a coding CLI created with its own `npm ci` / `npm install`
replaces the provisioned symlink, which silently puts the rest of the session
back on NFS. The next turn restores the link when a copy for that exact lockfile
is available (`deps_relinked`) and discards the tree in the background; when
nothing is provisioned for the lockfile, the CLI's tree is left alone.
