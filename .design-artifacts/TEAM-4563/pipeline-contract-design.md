# TEAM-4579 design: the pipeline arg contract guard

Repo `tycenjmccann/agentcore-hub`, branch `main` at `a0e4b90` (all line numbers below
were verified against that commit; see `head-line-check.txt`). This document is
NORMATIVE. `reference-check-pipeline-contract.py` (same directory) is a throwaway
prototype that implements exactly this algorithm and was used to verify every
claim below against HEAD; its `--explain` output is in `head-explain.txt`.
`architecture-diagram.html` (Mermaid) and `architecture-diagram.png` show the
inputs -> passes -> checks -> exit codes -> rails flow.

Deliverables of the implementation PR (not this turn):

| File | Role |
|---|---|
| `deploy/pipeline/pipeline-contract.json` | the declared contract (section 1) |
| `deploy/pipeline/check-pipeline-contract.py` | the guard, stdlib only (sections 2-5) |
| `scripts/check-pipeline-contract.sh` | bash wrapper, both CI rails (section 6) |
| `deploy/pipeline/test_check_pipeline_contract.py` | pytest battery + fixtures under `deploy/pipeline/fixtures/pipeline-contract/` (section 7) |
| docs | DEPLOY.md, deploy/pipeline/README.md, docs/architecture.md DL-028, docs/pipeline/design.md (section 9) |

---

## 0. Summary

### 0.1 What broke

PR #576 (merge `e4bd44c`, TEAM-4525) made `buildspec-deploy.yml` and
`buildspec-runtime-images.yml` read `DEPLOY_PREAPPROVED`, provided as an
action-level env var `#{BuildVars.DEPLOY_PREAPPROVED}` in
`deploy/pipeline/lib/pipeline-stack.ts` (lines 525-529 and 540-544). Stack SOURCE
and buildspec AGREED. The break was SOURCE vs DEPLOYED stack:
`./deploy/pipeline/deploy.sh` is a HANDOFF (a human runs it) and had not run.
CodePipeline resolves an unknown variable to the empty string, so every `main`
deploy failed at `PRE_BUILD` until a human redeployed the stack and PR #579
(merge `8f09987`, TEAM-4527) made `preapproved-check.sh gate` tolerate empty.

### 0.2 The critical nuance: source vs deployed

A contract auto-generated from `pipeline-stack.ts` would have PASSED #576, because
#576 was internally consistent. The only thing that can catch this class is a
DECLARED list that a human advances when the deployed pipeline actually provides
the argument. Therefore `deploy/pipeline/pipeline-contract.json` is hand-edited,
never generated, and the guard enforces ASYMMETRIC parity:

- (a) every contract entry MUST be declared in stack source for at least one of
  its `providedBy` providers (the contract cannot invent an arg);
- (b) a stack-source arg MISSING from the contract is ALLOWED and means "declared
  in source, not yet confirmed deployed"; any buildspec reading it FAILS until the
  contract is advanced (with the #576-specific message, section 5).

Adding an entry to the contract is therefore an assertion about the DEPLOYED
pipeline: run `./deploy/pipeline/deploy.sh` first (or in the same release), or
make the consuming buildspec tolerate absence.

### 0.3 Why syntactic form is not the Definition of Done

Syntactic form did NOT separate #576 from #579: both read
`"${DEPLOY_PREAPPROVED:-}"` (deploy.yml line 68, runtime-images.yml line 44); the
difference was inside `preapproved-check.sh` (how an empty value is interpreted).
So the required/tolerated distinction (FR-10) is a SHOULD shipped as an optional
schema field plus an opt-in flag (section 8), not the DoD. The DoD is the
asymmetric parity check in 0.2, which catches the #576 shape regardless of how
the read is spelled.

### 0.4 Scope and constraints

- Hub repo only. `deploy/pipeline/lib/pipeline-stack.ts` is a read-only INPUT to
  the guard and is never modified by this feature. Because the stack is
  untouched, NO `deploy.sh` HANDOFF is expected from this PR.
- No orchestrator change, no new env var, no new module/UI/API, no AWS calls, no
  network, no subprocesses. Python stdlib only (`re`, `json`, `sys`, `argparse`,
  `pathlib`, `glob`).
- Python 3.9 compatible (no `match`, no `X | Y` type unions): CodeBuild's managed
  image and the CI image (`deploy/pipeline/ci-image/Dockerfile` line 46 installs
  `python3`) are the floor; GitHub CI runs 3.13.
- Hyphens, never em dashes, in every string that could land in an AWS resource
  name or description, in every FAIL/OK message and in the drafted doc text.
- Budget: guard `< 5 s` at HEAD (measured 0.09 s with the prototype); pytest
  battery `< 30 s`.

### 0.5 Definition of Done mapping

| DoD item | Satisfied by |
|---|---|
| (1) A regression fixture reproducing #576 fails | fixture `regression-576` (7.3): `deploy.yml` reads `${DEPLOY_PREAPPROVED:-}`, `stack.txt` declares it on action `Deploy_it`, the contract's deploy entry lacks it -> exit 1 with the P5b message; `regression-576-fixed` shows the same fixture passing once the entry is added. |
| (2) The three HEAD buildspecs pass with zero false positives, including #579's tolerant shape | `head-pass` (7.3) and the `--explain` pin (4.12, 12.2): `${DEPLOY_PREAPPROVED:-}` in both deploy buildspecs is a CONSUMED read covered by the contract's `tolerated` entries; `OK: pipeline contract - 3 buildspecs, 17 provided vars, 3 namespace refs checked`. |
| (3) `pipeline-contract.json` exists, covers every consumed arg, and is referenced from DEPLOY.md | section 1.2 (the file, verbatim), 4.12 (CONSUMED sets are subsets of `provides`), 9.1 (the "Pipeline mode" callout sentence and the new DEPLOY.md subsection), pinned by the contract-stack-path and `$comment` pins in 7.3. |
| (4) Wired into BOTH rails unconditionally | 6.1-6.4: `scripts/check-pipeline-contract.sh`, the ci.yml build-job step (no path filter), the buildspec-ci.yml pre_build line, and the pytest file in both battery lists; pinned by the lockstep test in 7.3. |

---

## Decisions (D1-D22, already made; recorded with rationale)

| # | Decision | Rationale |
|---|---|---|
| D1 | Allowlist lives INLINE in the contract as `"allow": { "NAME": "one-line reason" }`. No sibling `.allow` file. The script never hardcodes names. | One file to review; a reason per name is enforceable by schema; no second discovery rule. |
| D2 | Providers are a FLAT list of names; CodeBuild `projectName` and CodePipeline `actionName` are both valid. A deploy buildspec lists both (project + action). Each `provides` entry is `{source, since, comment, absence?}`; `source` is VALIDATED against the stack. Unknown keys anywhere = exit 2; `$comment` allowed anywhere. | Env can be attached at project or action level in CDK; the flat list matches how the stack text reads. Validated `source` makes the contract self-documenting and drift-proof. |
| D3 | `export NAME` / `readonly NAME` WITHOUT `=` are READS. `export NAME=...` etc. are definitions (self-ref rule applies). `declare|typeset|local [flags] NAME` without `=` ARE definitions. | A bare export re-exports an existing value: `export AWS_REGION_HUB ACCOUNT_ID ARTIFACT_BUCKET ECR_REPO ECS_SERVICE_ARN` (deploy.yml 96) is exactly how the deploy buildspec consumes four pipeline args. |
| D4 | Single-quoted strings are TRANSPARENT for reads. | Fail-closed: `trap '...'`, `bash -c '...'`, `sh -c`, `eval`, `xargs`, `find -exec` bodies expand later and DO read env. A literal `'$UPPER'` is a loud false positive fixed by allowlisting or rewriting; skipping would be a silent miss (the #576 class). JMESPath `--query` strings never contain `$NAME`; awk `$(NF-1)` is `$(` and never matches. Pinned by fixtures `single-quoted-read-counts` and `trap-body-read`. |
| D5 | `#` starts a comment only when at line start (after indentation) or preceded by whitespace, AND the count of unescaped `"` before it on the line is even, AND the next char is not `{`. Comment text -> spaces. | `${X#..}`, `${X##..}`, `$#` are preceded by a non-space and never comments; offsets/line numbers survive. YAML comments follow the same rule. |
| D6 | `#{` never starts a comment; `#{Ns.VAR}` tokens are extracted from comment-stripped text only. | deploy.yml line 48 mentions `"#{BuildVars...}"` inside a `#` comment and must not count. |
| D7 | Heredocs: `(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1` after comment stripping; body ends at the first later line matching `^\s*TAG\s*$`. Quoted tag -> body blanked; unquoted -> body scanned for reads (refinement: never for definitions, a body is data). Unterminated -> exit 2. | ci.yml 389 `<<'PY'` carries Python with `{...}` and `$`-free text; `<<<` here-strings (deploy.yml 288, 311) are excluded by the lookbehind. |
| D8 | Definitions only in STATEMENT POSITION: line start, or after an unquoted `;` `&&` `||` `|` `&` `(` `)` `{` `}` backtick `$(`, or after a keyword from `then do else elif if while until ! time env nohup exec command` followed by whitespace. A run of leading `NAME=...` words is a command-prefix chain. Words are consumed by a char walker honouring quotes and `$(...)`/`${...}` nesting. Refinements: a backslash-newline continues the statement (so a continuation line is not a new statement start), and `)` `}` are delimiters too (case patterns `*) X=1 ;;`). | `--build-arg NAME=value` (ci.yml 281) and `imageTag="$X"` (ci.yml 295) are NOT definitions; reads inside them still count. |
| D9 | SELF-REFERENTIAL rule: for `NAME[idx]?+?=RHS`, compute reads in RHS FIRST; if NAME is read in its own RHS the assignment is a read, not a definition. A name whose ONLY assignments are self-referential is not DEFINED. | `EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}"` (runtime-images 134) is how EVENTS_TABLE is consumed; `GIT_SHA="$(printf '%s' "$GIT_SHA" \| cut -c1-12)"` (ci 279) is a read of a name defined at 278. |
| D10 | DEFINED is whole-file and ORDER-INSENSITIVE. | Functions are defined before they are called; CodeBuild runs all phases in one shell. |
| D11 | `--buildspec PATH` (repeatable): PATH normalised relative to `--root`; a contract key -> that entry; else exactly ONE contract key with the same basename -> scan PATH with that entry (messages print PATH and append ` (contract entry <key>)` to the message); else violation `no contract entry`, exit 1. Without `--buildspec`, scanned set = contract keys + filesystem glob of `<root>/deploy/pipeline/buildspec-*.yml` and `<root>/buildspec-*.yml`; a globbed file not in the contract -> exit 1. | Serves AC-8.5 (unknown file -> 1) and AC-8.13 (a temp copy of buildspec-deploy.yml with an added `echo "$FOO_BAR"` -> 1 naming FOO_BAR and its line). |
| D12 | Fixtures under `deploy/pipeline/fixtures/pipeline-contract/<case>/` with `stack.txt`, `contract.json` (`"stack": "stack.txt"`, buildspecs keyed `buildspec.yml`, `deploy.yml`), `buildspec.yml` (+ `deploy.yml`). `.txt` because `deploy/pipeline/tsconfig.json` has no `include`, so `npm run typecheck` compiles every `.ts` under `deploy/pipeline`. No real account ids (`scripts/check-no-hardcoded-accounts.sh`); `surfaces.json` line 9 already ignores `(^|/)fixtures/` and line 333 excludes `deploy/pipeline`. | Keeps typecheck green and the surface manifest untouched. |
| D13 | FR-10 ships as an OPTIONAL `absence` field (`required` default, `tolerated`) enforced ONLY behind `--strict-absence`, which is NOT wired into either CI rail in this PR. Default mode MUST pass HEAD. | Section 8. At HEAD `--strict-absence` reports ECR_REPO at ci.yml 236 and 294; deliberate follow-up. |
| D14 | Discovery uses filesystem globbing, never git or any subprocess. | Deterministic, works on the CodeBuild ZIP checkout and on a temp fixture dir alike. |
| D15 | Infrastructure errors (exit 2) abort at the FIRST error with exactly one `FAIL:` line; fixed processing order (contract load -> schema -> allow -> stack -> buildspecs sorted). Contract violations (exit 1) are collected, de-duplicated, sorted by `(path, line, var, message)`, printed one per line to stderr. | Deterministic, diff-able output (pinned by the determinism test). |
| D16 | YAML handled with `re` only (block scalars, double/single-quoted list scalars, plain items, `env:` sub-block); a `- "` without a closing quote on the line -> exit 2 "unsupported multi-line quoted scalar". CRLF normalised; strict UTF-8. | No PyYAML in the CodeBuild image; the three buildspecs use only these forms (and their headers say so: quoted scalars are mandatory). |
| D17 | Escapes before read extraction: `\\` -> two spaces, then `\$` -> two spaces. READ regexes: bare `\$([A-Za-z_][A-Za-z0-9_]*)`, braced `\$\{[#!]?([A-Za-z_][A-Za-z0-9_]*)`; keep only names matching `^[A-Z][A-Z0-9_]*$`. Namespace tokens `#\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\}`. Tolerant form `\$\{NAME:?[-+]`. | `\$NAME` is not a read but `\\$NAME` is; `$Account`, `$rc`, `${attempt}` are ignored entirely; `$$ $? $! $# $@ $* $0-$9 $( $(( $' $"` never match. |
| D18 | CONSUMED = READS ∩ UPPER minus DEFINED minus `CODEBUILD_*` minus `allow`. Violation iff CONSUMED is not a subset of the union of the buildspec's `provides` keys. Message picks the #576 fix (P5b) when the var IS declared in stack source for one of the providedBy, else the generic FR-6 fix (P5a); both start with the FR-6 phrase `reads <VAR> which pipeline-contract.json does not declare for [...]`. | Sections 3 and 5. |
| D19 | Stack parse is TEXTUAL, single pass, no node/tsc/cdk. | Section 2. The Build stage's pytest battery has no `deploy/pipeline/node_modules`; `test_preapproved_check.py` 559-576 already pins the stack textually. |
| D20 | Extra parity checks (exit 1): provider/buildspec binding, action/project binding, missing provider, unknown provider. | Section 3. |
| D21 | Namespace checks (FR-3): every `#{Ns.VAR}` in stack and buildspecs must name a contract namespace; builtin namespaces pass; else VAR must be in the exporter's `env.exported-variables` and the stack must carry `variablesNamespace: "Ns"` on exactly `namespaces[Ns].action`. Exporter must be a contract buildspec key (schema, exit 2). | Section 3. |
| D22 | The contract's `stack` path is relative to `--root`; `--stack` overrides. `--emit-from-stack` is RESERVED (flag name only, exits 2 "reserved"); a future helper MAY print the stack-source view as JSON for diffing but MUST NOT write the contract or be treated as source of truth. | The source-vs-deployed nuance (0.2) forbids auto-generation. |

---

## 1. Contract schema (FR-1) and the initial contract for HEAD

### 1.1 Schema

```
Contract := {
  "$comment"?:  string,                       // allowed and ignored at EVERY level
  "stack":      string,                       // repo-relative path, non-empty
  "namespaces": { <Ns>: Namespace, ... },     // object (may be empty)
  "buildspecs": { <repo-relative path>: Buildspec, ... },   // non-empty object
  "allow":      { <NAME>: <one-line reason string>, ... }   // object; NAME matches ^[A-Za-z_][A-Za-z0-9_]*$
}
Namespace := { "builtin": true }                          // codepipeline, variables
           | { "exporter": <buildspecs key>, "action": <actionName> }  // both non-empty; exporter MUST be a buildspecs key
Buildspec := {
  "providedBy": [ <projectName | actionName>, ... ],      // non-empty list of non-empty strings
  "provides":   { <VAR>: Entry, ... }                     // VAR matches ^[A-Z][A-Z0-9_]*$
}
Entry := {
  "source":  "common" | "project" | "action",             // REQUIRED, validated against the stack (rule P3)
  "since":   string (non-empty),                          // TEAM id / PR that introduced it
  "comment": string (non-empty),                          // why / what deploys it
  "absence"?: "required" | "tolerated"                    // OPTIONAL, default "required" (D13)
}
```

Schema violations are infrastructure errors (exit 2, section 5.3): unknown key at
any level, missing required key, wrong type, empty required string, bad `source`
or `absence` value, VAR not upper-case, exporter not a buildspecs key, allow name
not an identifier or with an empty reason.

Names only, never values: the contract never carries account ids, ARNs or bucket
names.

### 1.2 Initial `deploy/pipeline/pipeline-contract.json` (verbatim, ready to paste)

Verified by the prototype at HEAD:
`OK: pipeline contract - 3 buildspecs, 17 provided vars, 3 namespace refs checked`.

```json
{
  "$comment": "Adding an entry here asserts the DEPLOYED pipeline provides it: run ./deploy/pipeline/deploy.sh first (or in the same release), or make the consuming buildspec tolerate absence.",
  "stack": "deploy/pipeline/lib/pipeline-stack.ts",
  "namespaces": {
    "$comment": "CodePipeline variable namespaces the stack or a buildspec may reference as #{Ns.VAR}. A non-builtin namespace is exported by one buildspec (env.exported-variables) on one action (variablesNamespace).",
    "BuildVars": {
      "exporter": "deploy/pipeline/buildspec-ci.yml",
      "action": "Build_and_gate"
    },
    "codepipeline": { "builtin": true },
    "variables": { "builtin": true }
  },
  "buildspecs": {
    "deploy/pipeline/buildspec-ci.yml": {
      "$comment": "Two callers, one file: the PR-check project (agentcore-hub-ci) and the deploy pipeline's Build stage (agentcore-hub-build via action Build_and_gate). Project-level vars below exist only on agentcore-hub-build; the buildspec reads them inside the BUILD_APP_IMAGE block or tolerantly.",
      "providedBy": ["agentcore-hub-ci", "agentcore-hub-build", "Build_and_gate"],
      "provides": {
        "AWS_REGION_HUB": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Hub region; commonEnvVars on every CodeBuild project (pipeline-stack.ts)."
        },
        "ARTIFACT_BUCKET": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Hub artifact bucket name; commonEnvVars. The Build stage reads config/agents.json and the last-deployed baselines from it."
        },
        "EXPECTED_ACCOUNT_ID": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Account guard input; commonEnvVars. buildspec-ci.yml does not read it today, the two deploy buildspecs do."
        },
        "ECR_REPO": {
          "source": "project",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "App image repository; set on agentcore-hub-build only. Read inside the BUILD_APP_IMAGE block, which the PR-check caller never enters."
        },
        "BUILD_APP_IMAGE": {
          "source": "project",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "\"true\" on agentcore-hub-build only; selects the artifact-emission block. Read as ${BUILD_APP_IMAGE:-false}."
        },
        "NEXT_PUBLIC_PIPELINE_ENABLED": {
          "source": "project",
          "since": "PR #263 pipeline pilot; hardcoded in the stack by PR #572 (2026-09-12)",
          "comment": "Baked into the app image as a docker --build-arg so the /pipeline tab shows. Read as ${NEXT_PUBLIC_PIPELINE_ENABLED:-}."
        }
      }
    },
    "deploy/pipeline/buildspec-deploy.yml": {
      "$comment": "The Deploy stage's app action: project agentcore-hub-deploy run by action Deploy_three_targets.",
      "providedBy": ["agentcore-hub-deploy", "Deploy_three_targets"],
      "provides": {
        "AWS_REGION_HUB": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Hub region; commonEnvVars."
        },
        "ARTIFACT_BUCKET": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Hub artifact bucket; commonEnvVars. Targets 2 and the rollback snapshot write under it."
        },
        "EXPECTED_ACCOUNT_ID": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Account guard (pre_build) mirrors deploy/config.sh; commonEnvVars."
        },
        "ECR_REPO": {
          "source": "project",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "App image repository for the promote-by-digest ECR URI."
        },
        "ECS_SERVICE_ARN": {
          "source": "project",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "ECS Express service to roll (Target 3); may be empty until the service exists, and the buildspec skips the roll when empty."
        },
        "DEPLOY_PREAPPROVED": {
          "source": "action",
          "since": "TEAM-4525 / PR #576, deployed after PR #579 recovery",
          "comment": "Action-level env on Deploy_three_targets bound to #{BuildVars.DEPLOY_PREAPPROVED}; re-checked by preapproved-check.sh gate before anything touches prod. The stack providing it was deployed after #579's recovery (TEAM-4527), which is why gate tolerates empty.",
          "absence": "tolerated"
        }
      }
    },
    "deploy/pipeline/buildspec-runtime-images.yml": {
      "$comment": "The Deploy stage's parallel runtime-image action: project agentcore-hub-runtime-image-deploy run by action Deploy_runtime_images.",
      "providedBy": ["agentcore-hub-runtime-image-deploy", "Deploy_runtime_images"],
      "provides": {
        "AWS_REGION_HUB": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Hub region; commonEnvVars. Also exported as AWS_REGION for the aws CLI and update-runtime-image.py."
        },
        "ARTIFACT_BUCKET": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Hub artifact bucket; the runtime baseline (last-deployed-runtime-sha.txt) lives under it."
        },
        "EXPECTED_ACCOUNT_ID": {
          "source": "common",
          "since": "PR #263 pipeline pilot (2026-09-02)",
          "comment": "Account guard (pre_build); commonEnvVars."
        },
        "EVENTS_TABLE": {
          "source": "project",
          "since": "PR #350 runtime-image CD (2026-09-04)",
          "comment": "Events table for the runtime.deploy performance marker. The buildspec defaults it (${EVENTS_TABLE:-agentcore-hub-events}), so absence is tolerated.",
          "absence": "tolerated"
        },
        "DEPLOY_PREAPPROVED": {
          "source": "action",
          "since": "TEAM-4525 / PR #576, deployed after PR #579 recovery",
          "comment": "Action-level env on Deploy_runtime_images bound to #{BuildVars.DEPLOY_PREAPPROVED}; same gate as the app action. The stack providing it was deployed after #579's recovery.",
          "absence": "tolerated"
        }
      }
    }
  },
  "allow": {
    "$comment": "Upper-case names a buildspec may read that no pipeline provides: baked into the build image or standard shell / tool env. One-line reason per name; the guard never hardcodes any.",
    "PLAYWRIGHT_BROWSERS_PATH": "baked into the CI image (deploy/pipeline/ci-image, TEAM-4448 R11); absent on the managed image, which is the legacy install path",
    "PATH": "standard shell environment",
    "HOME": "standard shell environment",
    "PWD": "standard shell environment",
    "USER": "standard shell environment",
    "SHELL": "standard shell environment",
    "TMPDIR": "standard shell environment",
    "IFS": "shell field separator (set locally by read loops)",
    "AWS_REGION": "aws CLI / SDK region; buildspecs set it from AWS_REGION_HUB",
    "AWS_DEFAULT_REGION": "aws CLI / SDK region fallback",
    "AWS_PROFILE": "aws CLI profile; never set in CodeBuild, read only by deploy/config.sh paths",
    "NODE_ENV": "node convention; buildspec-ci.yml deliberately leaves it unset",
    "CI": "set by CI systems; tools change behaviour on it",
    "LANG": "locale",
    "LC_ALL": "locale"
  }
}
```

Origins (from `git log -S`): the four projects, `commonEnvVars`, `ECR_REPO`,
`BUILD_APP_IMAGE`, `ECS_SERVICE_ARN` and `NEXT_PUBLIC_PIPELINE_ENABLED` all enter
in `2736ce2` (PR #263, 2026-09-02); `EVENTS_TABLE` in `8522de9` (PR #350,
2026-09-04); `NEXT_PUBLIC_PIPELINE_ENABLED` was moved from `process.env` to a
literal in `4608afd` (PR #572, 2026-09-12); `DEPLOY_PREAPPROVED` in `e4bd44c`
(PR #576).

---

## 2. Stack parse (FR-2, AC-2.5)

Input: the file named by `contract.stack` (or `--stack`), read as bytes, strict
UTF-8 (decode error -> exit 2), `\r\n` -> `\n`. Output: the stack-source view
(2.6). Textual, single pass, no node/tsc/cdk.

### 2.1 Step 1: comment stripping state machine -> `code`

A char-level state machine over `src` with a mode stack. Output `code` has the
same length as `src`: comments are replaced by spaces, newlines are kept.

```
stack = ["code"]
while i < n:
  c = src[i]; nxt = src[i+1]
  mode = stack[-1]
  if mode is "code" or mode is ["expr", depth]:
    "//"  -> blank to end of line (not incl. the newline)
    "/*"  -> find "*/" (none -> exit 2 "unterminated block comment"); blank, keep newlines
    '"'   -> push "dq";  "'" -> push "sq";  "`" -> push "tpl"
    if mode is expr: "{" -> depth+1 ; "}" -> depth-1, and if depth==0 pop (back to tpl)
    else copy c
  elif mode in ("dq","sq"):
    "\\"  -> copy 2 chars (escape)
    "\n"  -> exit 2 "unterminated string literal"
    closing quote -> pop
  elif mode is "tpl":
    "\\"  -> copy 2 chars
    "`"   -> pop
    "${"  -> push ["expr", 1]
    else copy c (newlines allowed)
if len(stack) != 1 -> exit 2 "unterminated string or template literal at end of file"
```

Known limitation (documented, fail-closed): regex literals are not modelled. A
`//` inside a regex literal (none at HEAD; line 43 `replace(/^[\^~]/, "")` has
none) would blank the rest of that line; the consequence is a missing anchor or
block (exit 2) or a missing var (loud contract-not-in-stack / undeclared-read
violation), never a silent pass.

### 2.2 Step 2: string masking -> `masked`

Same pass, second output: `masked` equals `code` except that the CONTENTS of
`"..."`, `'...'` and template literals (outside `${...}` expressions) are
replaced by spaces; the quotes are kept and lengths are equal. This is what lets
brace walks ignore `{`/`}` inside `"#{BuildVars.DEPLOY_PREAPPROVED}"` (lines 487,
527, 542), the `/*` inside `` `${artifactBucket.bucketArn}/config/*` `` (line 283)
and the `//` in `` `https://github.com/...` `` (line 506).

### 2.3 Step 3: anchors (regexes run on `masked`; string VALUES read from `code` at the same offsets)

| Anchor | Regex (on `masked`) | Then |
|---|---|---|
| common block | `\bconst\s+commonEnvVars\b[^=]*=\s*\{` | must match EXACTLY once (else exit 2 `expected exactly one \`const commonEnvVars = {\` block, found N`); brace-walk from the `{` |
| env block | `\benvironmentVariables\s*:\s*` | next char `{` -> brace-walk; else identifier `(\w+)`: must be `commonEnvVars` (else exit 2 `environmentVariables bound to 'X' (only a { block } or commonEnvVars is understood)`) |
| project | `\bprojectName\s*:\s*` | next char must be `"` (else exit 2 `projectName is not a string literal`); value = `"([^"]*)"` matched on `code` at that offset |
| action | `\bactionName\s*:\s*` | same, `actionName is not a string literal` |
| namespace | `\bvariablesNamespace\s*:\s*` | same |
| buildspec | `\bfromSourceFilename\(\s*` | same |
| project const | `\bconst\s+(\w+)\s*=\s*new\s+codebuild\.(?:Pipeline)?Project\(` | binds ident -> the FIRST `projectName:` anchor after it (none -> exit 2) |
| action binding | `\bproject\s*:\s*(\w+)\s*,` | ident must be a bound project const (else exit 2); attributed to the nearest preceding action |
| token | `#\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\}` | run on `code` (comment-stripped, UNMASKED) |

`brace_walk(masked, open_idx)`: depth counter from the `{`; returns the index of
the matching `}`; running off the end -> exit 2 `unbalanced braces`.

### 2.4 Step 4: keys inside an env block

Walk the block char by char tracking depth (1 just inside the opening `{`).
For every line whose depth AT LINE START is 1, take the masked segment from the
line start to `min(line end, closing brace offset)`; skip blank segments; the
segment MUST match

```
^\s*(?:\.\.\.(\w+)|([A-Za-z_]\w*)|"([^"]+)")\s*(?::|,|$)
```

- group 1 (`...ident`): must be `commonEnvVars` -> expands common (else exit 2
  `spread of X in environmentVariables block (only ...commonEnvVars is understood)`);
  inside the common block itself a spread is exit 2;
- group 2 / group 3: key text read from `code` at the match span; a key matching
  `[A-Z][A-Z0-9_]*` is a var; any other key is ignored;
- no match -> exit 2 `unrecognised entry in environmentVariables block: <text>`.

Nested value objects (`DEPLOY_PREAPPROVED: {` ... `value: ...` ... `},`) are
handled by the depth rule: `value:` is at depth 2, the closing `},` line starts at
depth 2, the block's own closing `}` line starts at depth 1 but is blank once cut
at the closing offset. Comment lines inside a block (301-313 has seven, lines
305-311) are already spaces. Limitation: one key per line (prettier formatting
guarantees it; a second key on the same line would be a loud miss, never a
silent pass).

### 2.5 Step 5: attribution

Every env block, `variablesNamespace`, `fromSourceFilename` and `project:` binding
belongs to the NEAREST PRECEDING `projectName:` or `actionName:` anchor
(whichever has the greater offset); none -> exit 2. A `variablesNamespace` or
`project:` attributed to a project, or a `fromSourceFilename` attributed to an
action, is exit 2. Source of a var: `common` when it arrived via `commonEnvVars`
(identifier or spread), else the owner's kind (`project` / `action`).

### 2.6 Step 6: output (the stack-source view)

```
providers            : {name -> {var -> "common"|"project"|"action"}}  for all 4 projects + all 5 actions
kinds                : {name -> "project"|"action"}
namespaces           : {ns -> actionName}
buildspec_of_project : {projectName -> repo-relative path}
project_of_action    : {actionName -> projectName}
tokens               : [(line, ns, var)]
```

### 2.7 What it extracts at HEAD (verified)

| Provider (kind, anchor line) | Var | Source | Declared at line |
|---|---|---|---|
| `agentcore-hub-ci` (project, 231; env identifier at 256; buildspec 253) | AWS_REGION_HUB / ARTIFACT_BUCKET / EXPECTED_ACCOUNT_ID | common | 175 / 176 / 177 |
| `agentcore-hub-build` (project, 295; block 301-313; buildspec 298) | the three common | common | 175-177 |
|  | ECR_REPO | project | 303 |
|  | BUILD_APP_IMAGE | project | 304 |
|  | NEXT_PUBLIC_PIPELINE_ENABLED | project | 312 |
| `agentcore-hub-deploy` (project, 328; block 334-338; buildspec 331) | the three common | common | 175-177 |
|  | ECR_REPO | project | 336 |
|  | ECS_SERVICE_ARN | project | 337 |
| `agentcore-hub-runtime-image-deploy` (project, 366; block 379-382; buildspec 370) | the three common | common | 175-177 |
|  | EVENTS_TABLE | project | 381 |
| `GitHub_main` (action, 410) | none | | |
| `Build_and_gate` (action, 436; `project: buildProject` 437; `variablesNamespace: "BuildVars"` 443) | none | | |
| `Approve_deploy` (action, 498) | none | | |
| `Deploy_three_targets` (action, 519; `project: deployProject` 520; block 525-529) | DEPLOY_PREAPPROVED | action | 526 |
| `Deploy_runtime_images` (action, 536; `project: runtimeImageProject` 537; block 540-544) | DEPLOY_PREAPPROVED | action | 541 |

`commonEnvVars` block 174-178. Project consts: `ciProject` 230 (`codebuild.Project`),
`buildProject` 294, `deployProject` 327, `runtimeImageProject` 362 (multi-line
call; the regex matches through `PipelineProject(`). `namespaces = {BuildVars ->
Build_and_gate}`. Tokens: 3, at lines 487, 527, 542, all `BuildVars.DEPLOY_PREAPPROVED`.
`project.projectName` property accesses at 566/568 have no colon and do not match.

Corrections to the anchor list in the ticket text: the Build block is 301-313 (the
comment is 305-311), the Deploy block is 334-338, `Deploy_three_targets` is at 519
(not 521) and `Deploy_runtime_images` at 536 (not 537). Everything else matched.

---

## 3. Asymmetric parity rules (FR-2, FR-3, D18, D20, D21)

All rules below are contract violations (exit 1). `K` is a contract buildspec key,
`PB` its `providedBy`, `S` the stack display path (the contract's `stack` value, or
`--stack` as given), `<path>` the buildspec path as given. Every message ends in a
one-line fix. Line-bearing messages print as `FAIL: <path>:<line> <text>` (a
space after the line, no colon, per FR-6); line-less messages print as `FAIL:
<text>`. The contract is ALWAYS named by its literal basename
`pipeline-contract.json`, and the stack by the literal `pipeline-stack.ts` inside
the fixed P5b phrase, so that reviewers grepping the FR-6 phrases find them; in
fixtures the stack is `stack.txt` (printed as `<S>` elsewhere) but the fixed
phrase stays as-is, which is intended. Under `--buildspec` with a basename match
(D11) the message is suffixed with ` (contract entry <K>)`.

| # | Rule | Condition | Message |
|---|---|---|---|
| P1 | unknown provider (AC-2.4) | a name in PB is neither a projectName nor an actionName | `FAIL: <K> providedBy names <P>, which is neither a projectName nor an actionName in <S> - fix: correct the name or remove it from providedBy` |
| P2a | provider/buildspec binding | project P in PB has `buildspec_of_project[P] != K` | `FAIL: <K> providedBy project <P> runs <bs>, not this buildspec - fix: move <P> to the entry for <bs> or fix the stack's fromSourceFilename` (`<bs>` is `<no buildSpec>` when the project has none) |
| P2b | action/project binding | action A in PB has `project_of_action[A]` not in PB, or none | `FAIL: <K> providedBy action <A> runs project <P>, which is not in providedBy - fix: add <P> to providedBy` / `FAIL: <K> providedBy action <A> runs no CodeBuild project - fix: remove it from providedBy` |
| P2c | missing provider (project) | stack project P with `buildspec_of_project[P] == K` not in PB | `FAIL: <S> project <P> runs <K> but is missing from its providedBy - fix: add <P> to buildspecs["<K>"].providedBy` |
| P2d | missing provider (action) | stack action A bound to such a P, not in PB | `FAIL: <S> action <A> (project <P>) runs <K> but is missing from its providedBy - fix: add <A> to buildspecs["<K>"].providedBy` |
| P3a | contract-not-in-stack (asymmetry side a, MUST) | `provides[VAR]` and no provider in PB declares VAR in its own stack block | `FAIL: pipeline-contract.json declares <VAR> for <K> but <S> provides it to none of [<PB joined by ", ">] - fix: remove it from the contract or add it to the stack (which is a HANDOFF)` |
| P3b | source mismatch | VAR is declared by some provider in PB, but never with `source` | `FAIL: pipeline-contract.json says <VAR> source=<s> for <K> but <S> declares it as <actual sources joined by "/"> for <providers joined by ", "> - fix: set source to <actual>` |
| P4 | stack-only var (asymmetry side b) | a stack var is in no contract entry | ALLOWED, no output ("declared in source, not yet confirmed deployed") |
| P5a | undeclared read (FR-6) | `n in CONSUMED(K)`, `n not in provides(K)`, and no provider in PB has n in its effective env (3.1) | `FAIL: <path>:<line> reads <VAR> which pipeline-contract.json does not declare for [<PB joined by "/">] - fix: if the deployed stack provides it (./deploy/pipeline/deploy.sh has run), add it under buildspecs["<K>"].provides; otherwise make the read tolerate absence or drop it, or add it to allow with a reason` |
| P5b | the #576 shape | same, but some provider in PB DOES have n in its effective env (declared in stack source) | `FAIL: <path>:<line> reads <VAR> which pipeline-contract.json does not declare for [<PB joined by "/">] - declared in pipeline-stack.ts but not in pipeline-contract.json: deploy the stack (./deploy/pipeline/deploy.sh) then add it to the contract, or make the read tolerate absence (${<VAR>:-})` |
| N1 | namespace not declared | token `#{Ns.VAR}` (stack or buildspec, comment-stripped) with Ns not a contract namespace | `FAIL: <path>:<line> references #{<Ns>.<VAR>} but <Ns> is not in pipeline-contract.json namespaces - fix: add the namespace (exporter + action, or builtin: true) or remove the reference` |
| N2 | namespace var not exported | Ns non-builtin and VAR not in the exporter's `env.exported-variables` | `FAIL: <path>:<line> references #{<Ns>.<VAR>} but <exporter> env.exported-variables does not export <VAR> - fix: add <VAR> to exported-variables or remove the reference` |
| N3a | exporter action mismatch | stack `variablesNamespace: "Ns"` is on action X but `namespaces[Ns].action` is Y | `FAIL: <S> declares variablesNamespace "<Ns>" on action <X> but pipeline-contract.json says action <Y> - fix: correct namespaces["<Ns>"].action` |
| N3b | namespace unwired | non-builtin Ns has no `variablesNamespace` in the stack | `FAIL: <S> has no variablesNamespace "<Ns>" but pipeline-contract.json declares namespace <Ns> - fix: remove the namespace or add variablesNamespace to the exporter action (a HANDOFF)` |
| F1 | no contract entry | `--buildspec` path resolves to no entry and not exactly one basename match, or a globbed `buildspec-*.yml` is not a contract key | `FAIL: <path> has no contract entry in pipeline-contract.json buildspecs - fix: add buildspecs["<path>"] (providedBy + provides) or remove the file` |
| A1 | strict absence (only `--strict-absence`, section 8) | a bare read of a var that is `tolerated` or not in the effective env of EVERY provider in PB | `FAIL: <path>:<line> reads <VAR> bare but it <is marked absence=tolerated> [and] <is not provided by <P1, P2>> - fix: read it as ${<VAR>:-} because the deployed pipeline may not provide it yet` |

P5 and A1 emit one line per READ occurrence (the same var read on three lines is
three FAIL lines, all sorted). Violations are collected as `(path, line, var,
message)`, de-duplicated and sorted on that tuple; `path` is `<K>` or `<S>` for
line-less rules.

### 3.1 Effective env of a provider

`effective(P)` = the stack vars of P itself, plus, when P is an action bound to a
project, that project's vars. This is used by P5 (to pick P5a vs P5b) and by A1
(per-provider refinement, AC-10.2). It is NOT used to widen P3a: the contract's
`source` is checked against the provider's OWN declaration.

---

## 4. Consumption scanner (FR-4)

### 4.1 Pipeline of passes

```
bytes -> strict UTF-8 decode (error -> exit 2) -> "\r\n" -> "\n"
  -> classify_yaml_lines      : one bash-view line per file line + env-block names     (4.2)
  -> strip_bash_comments      : D5, per line, comment -> spaces                        (4.3)
  -> blank_heredocs           : D7 -> (read_base, walk_text)                           (4.4)
  -> remove_escapes           : D17 on read_base -> read_text (same length as walk_text)(4.5)
  -> extract_reads            : regexes on read_text -> READS [(name, line, form)]     (4.6)
  -> scan_statements          : walker on walk_text -> DEFINED, self-ref, bare exports (4.7-4.9)
  -> env-block definitions    : env.variables / parameter-store / secrets-manager keys, exported-variables items -> DEFINED
  -> set algebra                                                                        (4.10)
```

Line numbers: every text keeps one line per file line, so
`line = text.count("\n", 0, offset) + 1` is the file line.

### 4.2 YAML line classification (D16, `re` only)

```
RE_BLOCK_OPEN = ^(\s*)(?:-\s*|[A-Za-z_-]+\s*:\s*)[|>][-+0-9]*\s*(#.*)?$
RE_DQ_SCALAR  = ^(\s*)-\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$
RE_SQ_SCALAR  = ^(\s*)-\s*'((?:[^']|'')*)'\s*(#.*)?$
RE_DQ_OPEN    = ^(\s*)-\s*"          RE_SQ_OPEN = ^(\s*)-\s*'
```

State `block_indent = None`. For each line:

1. if `block_indent` is set and the line is blank or indented MORE than
   `block_indent` -> body line, bash view = the line verbatim; else clear the state;
2. `RE_BLOCK_OPEN` -> `block_indent = len(group 1)` (the dash/key column); bash
   view = the line (harmless);
3. `RE_DQ_SCALAR` -> bash view = indent + unescaped content (`\"` -> `"`, `\\` ->
   `\`, other escapes left as-is);
4. `RE_SQ_SCALAR` -> bash view = indent + content with `''` -> `'`;
5. `RE_DQ_OPEN` or `RE_SQ_OPEN` without a full match -> exit 2
   `unsupported multi-line quoted scalar at <path>:<line>` (none exist today);
6. anything else -> bash view = the line (YAML keys/values scanned as bash text,
   harmless: `version: 0.2`, `- DEPLOY_PREAPPROVED`, `files:` contain no `$NAME`).

`env:` block (raw lines): the line `^env:\s*(#.*)?$`; children are the following
lines with indent > 0 (blank and `#` lines skipped); `child_indent` = indent of the
first child. A child at `child_indent` matching `^(\s+)([A-Za-z_-]+)\s*:\s*(.*)$`
selects the section. Deeper lines: in `variables` / `parameter-store` /
`secrets-manager`, `^\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:` -> DEFINED; in
`exported-variables`, `^\s+-\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(#.*)?$` -> DEFINED and
appended to `exported` (used by N2).

### 4.3 Bash comment stripping (D5)

Per line, scanning left to right and skipping the char after a `\`: count `"`;
at a `#`, if (`k == 0` or `line[k-1].isspace()`) and `count % 2 == 0` and the next
char is not `{`, replace from `k` to end of line with spaces. Consequences: a `#`
inside a double-quoted string on the same line is kept; `${X##*/}` and `$#` are
kept (preceded by a non-space); `#{Ns.V}` is kept (D6). Known limitation
(fail-closed): a ` #` inside SINGLE quotes is treated as a comment and unbalances
the quote for the walker, which then misses definitions until the next `'`;
reads still count, so the failure is a loud false positive. None exists at HEAD
(verified by grep).

### 4.4 Heredoc blanking (D7)

```
RE_HEREDOC = (?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1
```

Per line of the comment-stripped text, for each match in order: find the first
later line matching `^\s*TAG\s*$` (none -> exit 2 `<path>:<line>: unterminated
heredoc <<TAG`). Body lines are blanked to spaces in `walk_text` always (a heredoc
body is data, never statements); in `read_base` only when the tag was quoted.
Subsequent heredocs on the same line start after the previous terminator. The
lookbehind excludes `<<<` here-strings at the first `<`; the second `<` of `<<<`
is preceded by `<`. `$(( x << 2 ))` never matches (`2` is not a tag).

### 4.5 Escape removal (D17)

`read_text = read_base.replace("\\\\", "  ").replace("\\$", "  ")` in that order.
Lengths are preserved, so `read_text` and `walk_text` share offsets.

### 4.6 Reads

```
RE_READ_BARE   = \$([A-Za-z_][A-Za-z0-9_]*)
RE_READ_BRACED = \$\{[#!]?([A-Za-z_][A-Za-z0-9_]*)
UPPER          = ^[A-Z][A-Z0-9_]*$
tolerant(pos)  = re.match(r"\$\{" + NAME + r":?[-+]", read_text[pos:])   # ${X:-} ${X-} ${X:+} ${X+}
```

Every match anywhere in `read_text` (quotes are transparent, D4) yields
`(name, line, form)` with `form = "tolerant"` for a braced tolerant match, else
`"bare"`. Names not matching UPPER are dropped. Bare `export NAME` / `readonly
NAME` words found by the walker add `(NAME, line, "export")` (D3; `export` counts
as tolerant for A1).

### 4.7 The word walker (D8)

`consume_word(text, i, hi) -> (end, subs)` consumes one shell word and returns the
`$(...)` / backtick spans found inside it (outside single quotes) for recursive
statement scanning.

```
top level (no open construct):
  '\'  -> skip 2 chars (escape, incl. backslash-newline)
  "'"  -> skip to the next "'" (unterminated -> to hi)
  '"'  -> open dq
  '$(' -> open sub ; '${' -> open param ; '`' -> open bt
  '('  -> open array ONLY if the previous char is '=' (X=(a b), declare -A M=())
  any of " \t\n;&|(){}`" -> END OF WORD
  else advance
inside dq:  '\' skip 2 ; '"' close ; '$(' open sub ; '${' open param ; '`' open bt
inside bt:  '\' skip 2 ; '`' close and record span
inside sub / param / array / paren / brace (code context):
  '\' skip 2 ; "'" skip to closing "'" ; '"' open dq ; '`' open bt
  '$(' open sub ; '${' open param ; '(' open paren ; '{' open brace
  the matching closer closes (a sub records its span)
```

`scan_statements(walk_text, read_text, lo, hi)`:

```
stmt = True ; pending = None
loop:
  skip ' ' and '\t'
  '\' + '\n'          -> skip 2 (continuation: NOT a statement boundary)
  '\n' or one of ";&|(){}`" -> stmt = True ; pending = None ; advance
  word = consume_word ; recurse into each recorded $( ) / ` ` span
  if pending (a builtin is collecting names):            # see 4.8
     handle the word as flag / name / assignment ; continue
  if stmt:
     if ASSIGN matches word     -> apply D9 (4.9) ; stay in stmt (prefix chain) ; continue
     if word in KEYWORDS        -> stay in stmt ; continue
     if word in BUILTINS        -> pending = word ; stmt = False ; continue
     stmt = False               # an ordinary command: its arguments are never definitions
```

```
KEYWORDS = then do else elif if while until ! time env nohup exec command
BUILTINS = export readonly declare typeset local read mapfile readarray for select
ASSIGN   = ^(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?P<idx>\[[^\]]*\])?\+?=(?P<rhs>.*)$   (DOTALL)
```

A word starting with `"` or `'` never matches ASSIGN, so
`echo "DEPLOY_PREAPPROVED=$DEPLOY_PREAPPROVED (...)"` (ci 380) defines nothing.

### 4.8 Builtin name collection

| Builtin | Flags | Then |
|---|---|---|
| `export`, `readonly` | words starting `-` skipped | `NAME=...` -> assignment (D9); bare `NAME` -> READ with form `export` (D3); anything else ends the list |
| `declare`, `typeset`, `local` | skipped | `NAME=...` -> assignment (D9); bare `NAME` -> DEFINED |
| `read` | `-[a-zA-Z]+`; for a two-char flag whose letter is one of `d n N t u p a i` the following word is skipped | names until a word that is not a name or starts with `<` |
| `mapfile`, `readarray` | flags; `-d -n -O -s -u -C -c` take an argument | the first name -> DEFINED |
| `for`, `select` | none | the next word -> DEFINED (`for FN in ...`) |

Other definition forms handled by ASSIGN: `NAME+=`, `NAME[expr]=` (e.g.
`BUILT_REF[$PAIR]="$REF"`, runtime-images 131), array `NAME=(...)`.

### 4.9 Self-referential rule (D9, AC-4.4)

For an ASSIGN word at offset `w`: `rhs = read_text[w + start(rhs) : w + len(word)]`;
`rhs_names = names of RE_READ_BARE ∪ RE_READ_BRACED over rhs`. If `name in
rhs_names` -> record as self-ref (a read; the global read pass already counted
it); else `DEFINED[name] = line`. A name with only self-ref assignments is not
DEFINED. Forms covered: `X="$X"`, `X="${X:-d}"`, `X=$X`, `export X="$X"`, and the
prefix chain `ARTIFACT_BUCKET="$ARTIFACT_BUCKET" AWS_REGION="$AWS_REGION_HUB" cmd`
(deploy 253: ARTIFACT_BUCKET read, AWS_REGION defined, AWS_REGION_HUB read).

### 4.10 Set algebra (D10, D18)

```
READS    = {(name, line, form)} from 4.6 (uppercase only)
DEFINED  = walker definitions ∪ env-block names          (whole file, order-insensitive)
CONSUMED = {n in names(READS) : n not in DEFINED and not n.startswith("CODEBUILD_") and n not in allow}
ALLOW    = {n in names(READS) : n in allow and n not in DEFINED}
BUILTIN  = {n in names(READS) : n.startswith("CODEBUILD_") and n not in DEFINED}
violation iff CONSUMED ⊄ keys(provides)       (one FAIL per read occurrence, rule P5a/P5b)
```

### 4.11 Worked table of the tricky HEAD lines

| File:line | Text (abridged) | Classification |
|---|---|---|
| ci 6 | `#   - CodePipeline "Build" stage (BUILD_APP_IMAGE=true): ...` | YAML comment (D5) -> spaces; not a definition |
| ci 32-33 | `exported-variables:` / `- DEPLOY_PREAPPROVED` | env block: DEPLOY_PREAPPROVED DEFINED + exported |
| ci 85-86 | `- \|` then `if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && ls -d "${PLAYWRIGHT_BROWSERS_PATH}"/chromium-* ...` | block opener (col 6); reads PLAYWRIGHT_BROWSERS_PATH (tolerant at 86, bare 86-90) -> ALLOW hit |
| ci 88 | `before="$(ls -d ... \| sort \| tr '\n' ' ')"` | assignment of lowercase `before`, ignored |
| ci 136 | `- "./scripts/check-deploy-surfaces.sh"` | quoted scalar, no reads |
| ci 157 | `- "PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run test:cloud-code -- --trace retain-on-failure"` | quoted scalar -> prefix chain at statement start: PLAYWRIGHT_BASE_URL DEFINED |
| ci 179 | `... \|\| { rc=$?; deactivate; echo "... (exit $rc)"; exit "$rc"; }` | `$?` never matches; `rc` lowercase |
| ci 201 | `deploy/pipeline/test_preapproved_check.py \|\| { rc=$?; ...; exit "$rc"; }` | plain words; no uppercase reads |
| ci 223 | `if [ "${BUILD_APP_IMAGE:-false}" = "true" ]; then` | read BUILD_APP_IMAGE, tolerant -> CONSUMED |
| ci 229 | `ZIP_ARGS="$(grep -oE 'zip -rq function\.zip .*' ... \| sed 's/^zip -rq function\.zip //')"` | ZIP_ARGS DEFINED; `\.` untouched by D17; single quotes inside `$( )` skipped by the walker |
| ci 235 | `ACCOUNT_ID="$(aws sts get-caller-identity ...)"` | ACCOUNT_ID DEFINED |
| ci 236 | `ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION_HUB}.amazonaws.com/${ECR_REPO}"` | ECR_URI DEFINED; reads ACCOUNT_ID (defined), AWS_REGION_HUB, ECR_REPO (bare) -> CONSUMED |
| ci 253 | `timeout 60 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done' \` | single-quoted body transparent; no `$` |
| ci 264 | `( set -o pipefail; aws ecr get-login-password --region "$AWS_REGION_HUB" \` | `(` delimiter; read AWS_REGION_HUB |
| ci 278 | `GIT_SHA="${CODEBUILD_RESOLVED_SOURCE_VERSION:-$(git rev-parse --short HEAD ... \|\| echo nogit)}"` | GIT_SHA DEFINED; CODEBUILD_RESOLVED_SOURCE_VERSION tolerant -> BUILTIN |
| ci 279 | `GIT_SHA="$(printf '%s' "$GIT_SHA" \| cut -c1-12)"` | self-referential -> read (GIT_SHA already DEFINED at 278) |
| ci 281 | `--build-arg NEXT_PUBLIC_PIPELINE_ENABLED="${NEXT_PUBLIC_PIPELINE_ENABLED:-}" \` | continuation of 280 (not statement start); `--build-arg` is not ASSIGN, so the `NAME=` word is an argument; read tolerant -> CONSUMED |
| ci 292-294 | `IMAGE_DIGEST=""` / `for attempt in ...` / `IMAGE_DIGEST="$(aws ecr describe-images --repository-name "$ECR_REPO" \` | IMAGE_DIGEST DEFINED; `attempt` lowercase; `"$ECR_REPO"` bare read at 294 -> CONSUMED (and the A1 finding under `--strict-absence`) |
| ci 295 | `--image-ids imageTag="$GIT_SHA" --region "$AWS_REGION_HUB" \` | `imageTag=` is an argument (continuation line), not a definition |
| ci 297-299 | `case "$IMAGE_DIGEST" in` / `sha256:*) break ;;` / `*) echo "... '$IMAGE_DIGEST' ..."; IMAGE_DIGEST=""; sleep 5 ;;` | `)` delimiter; `IMAGE_DIGEST=""` after `;` is a definition |
| ci 368-380 | `DEPLOY_PREAPPROVED=0` / `export DEPLOY_PREAPPROVED` / ... / `DEPLOY_PREAPPROVED="$(bash ... decide "$FULL_SHA")"` / `case ...` / `export DEPLOY_PREAPPROVED` / `echo "DEPLOY_PREAPPROVED=$DEPLOY_PREAPPROVED (...)"` | DEFINED at 368 (and 373, 376); bare exports at 369/378 are reads (form `export`); 380 is inside a quoted word -> no definition |
| ci 389-396 | `python3 - /tmp/pytest-battery-junit.xml <<'PY' \|\| true` ... `PY` | quoted heredoc: 390-395 blanked; terminator 396 `^\s*PY\s*$` |
| deploy 43 | `# Build stage exported DEPLOY_PREAPPROVED=1, meaning ...` | comment -> not a definition |
| deploy 48 | `# value that is neither -- an unresolved "#{BuildVars...}", whitespace,` | comment -> the token is NOT counted (D6) |
| deploy 68 | `bash deploy/pipeline/preapproved-check.sh gate "${DEPLOY_PREAPPROVED:-}" "$(cat ... \|\| true)" \` | DEPLOY_PREAPPROVED tolerant read -> CONSUMED |
| deploy 70 | `- "ACCOUNT_ID=\"$(aws sts get-caller-identity --query Account --output text)\""` | quoted scalar unescaped to `ACCOUNT_ID="$(aws ...)"` -> ACCOUNT_ID DEFINED; `$Account`? none (`--query Account` has no `$`) |
| deploy 73 | `if [ -n "${EXPECTED_ACCOUNT_ID:-}" ] && [ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then` | EXPECTED_ACCOUNT_ID tolerant + bare -> CONSUMED |
| deploy 96 | `export AWS_REGION_HUB ACCOUNT_ID ARTIFACT_BUCKET ECR_REPO ECS_SERVICE_ARN` | BARE export = five READS (D3); ACCOUNT_ID is DEFINED, the other four -> CONSUMED |
| deploy 139 / 306 | `ECS_CLUSTER="$(printf '%s' "$ECS_SERVICE_ARN" \| awk -F/ '{print $(NF-1)}')"; ECS_SVC="${ECS_SERVICE_ARN##*/}"` | both DEFINED; `$(NF-1)` never matches; `##` not a comment; ECS_SERVICE_ARN bare read |
| deploy 141 / 312 | `--query 'services[0].deployments[?status==\`PRIMARY\`] \| [0].taskDefinition'` | single-quoted JMESPath; no `$NAME`; backticks inside quotes are skipped by the walker |
| deploy 147 | `trap 'rc=$?; if [ $rc -ne 0 ]; then ...; exit $rc' EXIT` | one single-quoted word; `$?`/`$rc` lowercase -> nothing |
| deploy 177 | `while IFS=$'\t' read -r KIND FN DIR NPM OPTIONAL FILES NOTE <&3; do` | `while` keyword; `IFS=$'\t'` prefix assignment (IFS DEFINED, `$'` no read); `read -r` then seven names DEFINED, stopping at `<&3` |
| deploy 227 / 250 | `while IFS=$'\t' read -r KIND SRC DST EXTRA <&3; do` / `... KIND HNAME HSCRIPT <&3` | same |
| deploy 246 | `PKGS="$(node -e 'const d=require("./package.json")...' \| tr '\n' ' ')"` | PKGS DEFINED; single quotes inside `$( )` skipped |
| deploy 253-254 | `PIPELINE_MODE=1 HARNESS_SNAPSHOT_DIR=/tmp/rollback/harness AWS_REGION="$AWS_REGION_HUB" ARTIFACT_BUCKET="$ARTIFACT_BUCKET" \` / `node "$HSCRIPT" < /dev/null` | prefix chain: PIPELINE_MODE, HARNESS_SNAPSHOT_DIR, AWS_REGION DEFINED; ARTIFACT_BUCKET self-ref -> read -> CONSUMED |
| deploy 288 / 311 | `read -r STATUS URL <<<"$(python3 ... "$DESC")"` / `read -r ROLLOUT TASKDEF NDEPLOY <<<"$(aws ecs ...` | `<<<` is not a heredoc (lookbehind); names DEFINED, stopping at the `<<<"..."` word |
| deploy 293 | `case "$URL" in http*) : ;; *) URL="https://$URL" ;; esac` | `URL="https://$URL"` after `)` is self-referential -> read; URL DEFINED at 285 |
| deploy 337 | `printf '%s' "$ROOT" \| grep -q 'href="/pipeline"' \|\| { ... }` | `"` inside single quotes: D5 parity irrelevant (no `#`); ROOT DEFINED at 324 |
| rt 44 | `... gate "${DEPLOY_PREAPPROVED:-}" ...` | tolerant read -> CONSUMED |
| rt 46 | `- "ACCOUNT_ID=\"$(aws sts get-caller-identity --query Account --output text)\""` | quoted-scalar definition |
| rt 48 | `if [ -n "${EXPECTED_ACCOUNT_ID:-}" ] && [ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then` | CONSUMED |
| rt 67 | `export AWS_REGION="$AWS_REGION_HUB"` | `export NAME=` -> AWS_REGION DEFINED; AWS_REGION_HUB read |
| rt 99 | `trap 'rc=$?; ...; for f in /tmp/rt-rollback/*.prev; do ... n="$(basename "$f" .prev)"; prev="$(cat "$f")"; ...; AWS_REGION="$AWS_REGION_HUB" python3 ... rollback "$n" "$prev" ...; done; fi; exit $rc' EXIT` | one single-quoted word; lowercase names ignored; `$AWS_REGION_HUB` read (transparent, D4); no definitions inside |
| rt 104 | `declare -A BUILT_REF=()` | `declare` + `NAME=(` array -> BUILT_REF DEFINED |
| rt 105 | `while IFS=$'\t' read -r KIND NAME REPO CTX; do` | IFS, KIND, NAME, REPO, CTX DEFINED |
| rt 108-109 / 131 | `if [ -n "${BUILT_REF[$PAIR]:-}" ]` / `REF="${BUILT_REF[$PAIR]}"` / `BUILT_REF[$PAIR]="$REF"` | braced reads of BUILT_REF and `$PAIR`; `NAME[expr]=` definition |
| rt 134-136 | `GIT_SHA="$GIT_SHA" EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}" \` / `RT_SNAPSHOT_DIR=/tmp/rt-rollback AWS_REGION="$AWS_REGION_HUB" \` / `python3 deploy/pipeline/update-runtime-image.py deploy "$NAME" "$REF"` | one prefix chain across continuation lines: GIT_SHA self-ref (read; defined at 68), EVENTS_TABLE self-ref -> read -> CONSUMED (tolerant), RT_SNAPSHOT_DIR and AWS_REGION DEFINED |

### 4.12 Expected sets at HEAD (verified by the prototype)

| Buildspec | CONSUMED | ALLOW | BUILTIN | DEFINED (uppercase) |
|---|---|---|---|---|
| buildspec-ci.yml | ARTIFACT_BUCKET, AWS_REGION_HUB, BUILD_APP_IMAGE, ECR_REPO, NEXT_PUBLIC_PIPELINE_ENABLED | PLAYWRIGHT_BROWSERS_PATH | CODEBUILD_RESOLVED_SOURCE_VERSION | ACCOUNT_ID, DEPLOY_PREAPPROVED, ECR_URI, FULL_SHA, GIT_SHA, IMAGE_DIGEST, LAST_DEPLOYED, LAST_RT, PLAYWRIGHT_BASE_URL, ZIP_ARGS |
| buildspec-deploy.yml | ARTIFACT_BUCKET, AWS_REGION_HUB, DEPLOY_PREAPPROVED, ECR_REPO, ECS_SERVICE_ARN, EXPECTED_ACCOUNT_ID | (none) | (none) | ACCOUNT_ID, AWS_REGION, DESC, DIR, DST, ECR_URI, ECS_CLUSTER, ECS_SVC, EXTRA, FILES, FN, GIT_SHA, HARNESS_SNAPSHOT_DIR, HNAME, HSCRIPT, IFS, IMAGE_DIGEST, KIND, LIVE_URL, NDEPLOY, NOTE, NPM, OPTIONAL, PIPELINE_MODE, PKGS, PREV_TASKDEF, PRIMARY, ROLLOUT, ROOT, SAME_IMAGE, SRC, STATUS, TASKDEF, URL |
| buildspec-runtime-images.yml | ARTIFACT_BUCKET, AWS_REGION_HUB, DEPLOY_PREAPPROVED, EVENTS_TABLE, EXPECTED_ACCOUNT_ID | (none) | (none) | ACCOUNT_ID, AWS_REGION, BUILT_REF, CTX, DIGEST, ECR_REG, GIT_SHA, IFS, IMG, KIND, NAME, PAIR, REF, REPO, RT_CHANGED, RT_SNAPSHOT_DIR, TAG |

Self-referential assignments observed: ci `GIT_SHA` (279); deploy
`ARTIFACT_BUCKET` (253), `URL` (293); runtime-images `GIT_SHA` (134),
`EVENTS_TABLE` (134). Exported: ci `[DEPLOY_PREAPPROVED]`; buildspec tokens: none
(deploy 48 is a comment). These match the AC-4.8 expectations exactly; no
deviation was observed.

### 4.13 `--explain` output format

One line per scanned buildspec, printed to stdout BEFORE the OK line (or before
the FAIL lines on stderr), every list sorted and comma-separated without spaces;
`defined` lists uppercase names only:

```
EXPLAIN: <path> providedBy=[..] provides=[..] consumed=[..] allow=[..] builtin=[..] defined=[..]
```

The HEAD output is in `head-explain.txt` (appendix 12.2).

---

## 5. Fail-closed behaviour, exit codes, messages, CLI (FR-5, FR-6)

### 5.1 Exit codes

| Exit | Meaning | Output |
|---|---|---|
| 0 | contract holds | exactly one stdout line: `OK: pipeline contract - <N> buildspecs, <V> provided vars, <T> namespace refs checked` where N = scanned buildspecs, V = sum of `provides` entries over the contract, T = `#{..}` tokens checked in stack + scanned buildspecs |
| 1 | contract violation(s) | every violation collected, de-duplicated, sorted by `(path, line, var, message)`, one line each on stderr as `FAIL: <path>:<line> <message>` (line-bearing) or `FAIL: <message>` (line-less), nothing on stdout (except `--explain` lines) |
| 2 | infrastructure error | the FIRST error only, exactly one `FAIL: ...` line on stderr |

Processing order (deterministic): contract load -> schema -> allow -> stack read/parse
-> `--buildspec` resolution / glob -> buildspec file existence in sorted key order
-> scans in sorted key order -> checks. Output text never contains an em dash.

### 5.2 Violation templates (exit 1)

Section 3 lists them all: P1, P2a-d, P3a, P3b, P5a, P5b, N1, N2, N3a, N3b, F1, A1.
Every one ends in a one-line fix. The fixed FR-6 phrases are `reads <VAR> which
pipeline-contract.json does not declare for [...]` (P5a/P5b), `declared in
pipeline-stack.ts but not in pipeline-contract.json` (P5b), `pipeline-contract.json
declares <VAR> for <K> but <S> provides it to none of [...]` (P3a) and `references
#{<Ns>.<VAR>} but <exporter> env.exported-variables does not export <VAR>` (N2);
they appear literally regardless of the actual file names passed. Under
`--buildspec` with a basename match, the message is suffixed with
` (contract entry <K>)`; `<path>` stays the path as given.

### 5.3 Infrastructure templates (exit 2)

| Situation | `FAIL: ` line |
|---|---|
| contract missing | `<C>: contract file missing` |
| contract unparseable | `<C>: unparseable JSON (<json error>)` / `<C>: not valid UTF-8 (<error>)` |
| top level not an object | `<C>: top level must be an object` |
| unknown top-level key | `<C>: unknown top-level key '<k>'` |
| missing required key | `<C>: missing required key '<k>'` |
| bad type / empty | `<C>: "stack" must be a non-empty string`, `<C>: "namespaces" must be an object`, `<C>: "buildspecs" must be a non-empty object`, `<C>: "allow" must be an object`, `<C>: buildspecs['<K>'] must be an object`, `<C>: buildspecs['<K>'].providedBy must be a non-empty list of names`, `<C>: buildspecs['<K>'].provides must be an object`, `<C>: buildspecs['<K>'].provides.<VAR> must be an object`, `<C>: buildspecs['<K>'].provides: '<x>' is not an UPPER_CASE variable name` |
| unknown entry / buildspec / namespace key | `<C>: buildspecs['<K>']: unknown key '<k>'`, `<C>: buildspecs['<K>'].provides.<VAR>: unknown key '<k>'`, `<C>: namespaces['<Ns>']: unknown key '<k>'` |
| bad entry values | `<C>: buildspecs['<K>'].provides.<VAR>.source must be "common", "project" or "action"`, `... .<since\|comment> must be a non-empty string`, `... .absence must be "required" or "tolerated"` |
| bad namespace | `<C>: namespaces['<Ns>'] must be an object`, `<C>: namespaces['<Ns>'].builtin must be true or false`, `<C>: namespaces['<Ns>'] needs "exporter" and "action" (or "builtin": true)`, `<C>: namespaces['<Ns>'].exporter '<x>' is not a buildspecs key` |
| bad allow | `<C>: allow: '<x>' is not a variable name`, `<C>: allow.<NAME> must be a non-empty one-line reason` |
| stack missing / undecodable | `<S>: stack file missing`, `<S>: not valid UTF-8 (<error>)` |
| stack unparseable | `<S>:<line>: unterminated block comment`, `<S>:<line>: unterminated string literal`, `<S>: unterminated string or template literal at end of file`, `<S>:<line>: unbalanced braces after offset <n>` |
| stack blocks unlocatable | `<S>: expected exactly one \`const commonEnvVars = {\` block, found <n>`, `<S>: no projectName:/actionName: literals found`, `<S>:<line>: <what> has no preceding projectName:/actionName:`, `<S>:<line>: <projectName\|actionName\|variablesNamespace\|fromSourceFilename> is not a string literal`, `<S>:<line>: environmentVariables bound to '<ident>' (only a { block } or commonEnvVars is understood)`, `<S>:<line>: spread of <ident> in environmentVariables block (only ...commonEnvVars is understood)`, `<S>:<line>: commonEnvVars may not spread`, `<S>:<line>: unrecognised entry in environmentVariables block: '<text>'`, `<S>:<line>: variablesNamespace attributed to a project, not an action`, `<S>:<line>: fromSourceFilename attributed to an action`, `<S>:<line>: project: binding attributed to a project`, `<S>:<line>: project: <ident> is not a \`const <ident> = new codebuild.*Project(\` binding`, `<S>:<line>: const <ident> = new codebuild.*Project( has no following projectName:` |
| buildspec missing / undecodable | `<path>: buildspec file missing`, `<path>: not valid UTF-8 (<error>)` |
| YAML | `unsupported multi-line quoted scalar at <path>:<line>` |
| heredoc | `<path>:<line>: unterminated heredoc <<TAG` |
| reserved flag | `--emit-from-stack is reserved and not implemented; the contract is never generated from the stack (source-vs-deployed)` |

### 5.4 CLI

```
check-pipeline-contract.py [--root DIR] [--contract FILE] [--stack FILE]
                           [--buildspec PATH]... [--explain] [--strict-absence]
                           [--emit-from-stack]   # reserved, exit 2
--root       default Path(__file__).resolve().parents[2], i.e. the repo root the
             script lives in (deploy/pipeline/ -> deploy/ -> root), the same
             derivation the sibling tests use; contract paths (stack, buildspec
             keys) are relative to it
--contract   default <root>/deploy/pipeline/pipeline-contract.json
--stack      overrides contract.stack (path as given; also used in messages)
--buildspec  repeatable; D11 resolution; without it: contract keys + glob (D14)
--explain    EXPLAIN lines (4.13) on stdout
--strict-absence  enable rule A1 (section 8); not wired in CI in this PR
```

The wrapper passes no `--root`, so the CI rails always check the checkout that
contains the script; the tests pass `--root <case-dir>` explicitly.

### 5.5 Invariants (pinned by the source-pin test)

The guard never writes a file, never spawns a subprocess, never imports `boto3`,
`urllib`, `requests`, `yaml` or `subprocess`, and reads no environment variable
(`os.environ` does not appear in its source; configuration is argparse only).
Its imports are exactly `argparse, glob, json, re, sys` and `pathlib.Path`.

---

## 6. Two-rail wiring (FR-7)

### 6.1 `scripts/check-pipeline-contract.sh` (mode 100755, full text)

```bash
#!/usr/bin/env bash
# ─── Pipeline arg contract guard (TEAM-4563 / TEAM-4579) ──────────────────────
#
# The CodeBuild projects and CodePipeline actions in deploy/pipeline/lib/
# pipeline-stack.ts PROVIDE env vars; the buildspecs CONSUME them. PR #576 made
# buildspec-deploy.yml and buildspec-runtime-images.yml read DEPLOY_PREAPPROVED,
# provided by the stack SOURCE as an action-level #{BuildVars.DEPLOY_PREAPPROVED}.
# Source and buildspec agreed - but ./deploy/pipeline/deploy.sh is a HANDOFF and
# had not run, CodePipeline resolved the unknown variable to "", and every main
# deploy failed at PRE_BUILD until a human redeployed the stack and PR #579 made
# the gate tolerate empty.
#
# A contract generated from the stack would have passed #576. So
# deploy/pipeline/pipeline-contract.json is a DECLARED list a human advances when
# the deployed pipeline actually provides an arg, and the guard is asymmetric:
# a contract entry must exist in stack source (the contract cannot invent an
# arg), but a stack-source arg missing from the contract is "declared, not yet
# confirmed deployed" and any buildspec reading it fails here. Same pass shape as
# scripts/check-deploy-surfaces.sh (bash -> python3, stdlib only, no AWS).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 deploy/pipeline/check-pipeline-contract.py "$@"
```

`git ls-files -s scripts/check-pipeline-contract.sh` must show `100755`, like
`scripts/check-deploy-surfaces.sh` and `scripts/check-cd-registry-parity.sh` do.

### 6.2 `.github/workflows/ci.yml` (build job)

Insert after the "Deploy-surface manifest guard" step (comment 93-95, step 96-97)
and its trailing blank line 98, before the "Hardcoded-account guard" comment
(currently 99-102, step 103-104); the new block is followed by one blank line, so
the Hardcoded-account block shifts down by 8 lines:

```yaml
      # TEAM-4563: the stack PROVIDES pipeline args, the buildspecs CONSUME them,
      # and pipeline-contract.json is the human-advanced record of what the
      # DEPLOYED stack provides (PR #576 agreed with its own stack source and
      # still broke main). Path-filtering a required check is an anti-pattern:
      # runs unconditionally, <5 s.
      - name: Pipeline arg contract guard
        run: ./scripts/check-pipeline-contract.sh
```

(The build job has no `setup-python`; `ubuntu-latest` ships `python3`, which is
what "Deploy-surface manifest guard" already relies on.)

### 6.3 `deploy/pipeline/buildspec-ci.yml` pre_build

After line 136 `- "./scripts/check-deploy-surfaces.sh"` add:

```yaml
      # Mirrors ci.yml's 'Pipeline arg contract guard' step (TEAM-4563): what the
      # deployed pipeline provides vs what the buildspecs read; fails on a read the
      # contract does not cover, even when the stack SOURCE declares it (#576).
      - "./scripts/check-pipeline-contract.sh"
```

### 6.4 The pytest lists

`.github/workflows/ci.yml`: after line 175 `deploy/pipeline/test_preapproved_check.py`
add `          deploy/pipeline/test_check_pipeline_contract.py` (same indentation,
the folded `run: >` block).

`deploy/pipeline/buildspec-ci.yml`: insert
`          deploy/pipeline/test_check_pipeline_contract.py \` as a NEW line BEFORE
line 201, so that line 201
`deploy/pipeline/test_preapproved_check.py || { rc=$?; deactivate; echo "runtime-agent pytest battery FAILED (exit $rc)"; exit "$rc"; }`
stays the LAST statement of the pytest command and `deactivate` (202) stays the
last line of the block. Why this and not "make the new file the tail carrier":
`test_buildspec_ci_exit_codes.py` pins `lines[-1].strip() == "deactivate"`
(line 89) and `pytest -q[\s\S]*?\|\|\s*\{[^}]*exit` (line 79) - both survive either
way, but keeping the TEAM-4525 file as the guard carrier leaves the tail untouched
(a one-line diff) and keeps `git blame` on the guard where it was. Its own
`test_this_file_runs_in_ci` (119-133) is the model for the lockstep pin in 7.3.

---

## 7. Test battery and fixture layout (FR-8)

### 7.1 Layout (D12)

```
deploy/pipeline/test_check_pipeline_contract.py
deploy/pipeline/fixtures/pipeline-contract/<case>/
    stack.txt        # minimal pipeline-stack excerpt (NOT .ts: tsconfig has no include)
    contract.json    # "stack": "stack.txt"; buildspecs keyed "buildspec.yml", "deploy.yml"
    buildspec.yml    # the exporter / build-side buildspec
    deploy.yml       # the deploy-side buildspec (present in every case for parity)
```

Tests run the guard as a subprocess: `[sys.executable,
"deploy/pipeline/check-pipeline-contract.py", "--root", case_dir, "--contract",
case_dir/"contract.json", *extra]`, cwd = repo root. `head-pass` uses `--root
<repo>` and the shipped contract. Fixture stacks contain `const commonEnvVars`, at
least one `environmentVariables` block, `projectName:`/`actionName:` strings and
no real account ids (`scripts/check-no-hardcoded-accounts.sh`; use `123456789012`
if an id is ever needed). `surfaces.json` line 9 ignores `(^|/)fixtures/` and
line 333 excludes `deploy/pipeline`, so the manifest guard is unaffected.

### 7.2 Base fixture (every case starts from this; the prototype battery used exactly it)

`stack.txt`:

```
// fixture stack excerpt (.txt so deploy/pipeline/tsconfig.json never compiles it)
const commonEnvVars: Record<string, codebuild.BuildEnvironmentVariable> = {
  AWS_REGION_HUB: { value: region },
  ARTIFACT_BUCKET: { value: artifactBucketName },
};
const buildProject = new codebuild.PipelineProject(this, "BuildProject", {
  projectName: "fixture-build",
  buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspec.yml"),
  environmentVariables: {
    ...commonEnvVars,
    // a project-level arg; the URL below has // inside a template literal
    ECR_REPO: { value: `${repoBase}/fixture-repo` },
  },
});
const deployProject = new codebuild.PipelineProject(this, "DeployProject", {
  projectName: "fixture-deploy",
  buildSpec: codebuild.BuildSpec.fromSourceFilename("deploy.yml"),
  environmentVariables: commonEnvVars,
});
new cpactions.CodeBuildAction({
  actionName: "Build_and_gate",
  project: buildProject,
  variablesNamespace: "BuildVars",
});
new cpactions.CodeBuildAction({
  actionName: "Deploy_it",
  project: deployProject,
  environmentVariables: {
    DEPLOY_PREAPPROVED: { value: "#{BuildVars.DEPLOY_PREAPPROVED}" },
  },
});
```

`contract.json`: stack `stack.txt`; namespaces `BuildVars` (exporter
`buildspec.yml`, action `Build_and_gate`) + `codepipeline` builtin; `buildspec.yml`
providedBy `[fixture-build, Build_and_gate]` provides AWS_REGION_HUB (common),
ARTIFACT_BUCKET (common), ECR_REPO (project); `deploy.yml` providedBy
`[fixture-deploy, Deploy_it]` provides the two common vars; allow
`{PLAYWRIGHT_BROWSERS_PATH: "baked into the CI image"}`. Every entry carries
`since`/`comment` = `"fixture"`.

`buildspec.yml`:

```yaml
version: 0.2
env:
  shell: bash
  exported-variables:
    - DEPLOY_PREAPPROVED
phases:
  build:
    commands:
      - "echo region $AWS_REGION_HUB bucket ${ARTIFACT_BUCKET} repo ${ECR_REPO:-}"
      - |
        DEPLOY_PREAPPROVED=0
        export DEPLOY_PREAPPROVED
```

`deploy.yml`:

```yaml
version: 0.2
env:
  shell: bash
phases:
  build:
    commands:
      - "echo deploy $AWS_REGION_HUB ${ARTIFACT_BUCKET}"
```

Base result: `OK: pipeline contract - 2 buildspecs, 5 provided vars, 1 namespace refs checked`.

### 7.3 Cases (all verified against the prototype: 55 runs, 0 unexpected, every run byte-identical on repeat)

| Case dir | Mutation from the base | Args | Exit | Required substring |
|---|---|---|---|---|
| `head-pass` | real repo, shipped contract | | 0 | `OK: pipeline contract - 3 buildspecs, 17 provided vars, 3 namespace refs checked` |
| `fixture-pass` | none | | 0 | `OK: pipeline contract - 2 buildspecs, 5 provided vars, 1 namespace refs checked` |
| `regression-576` | deploy.yml adds `- "bash gate.sh \"${DEPLOY_PREAPPROVED:-}\""` (line 8); contract deploy entry lacks DEPLOY_PREAPPROVED | | 1 | `FAIL: deploy.yml:8 reads DEPLOY_PREAPPROVED which pipeline-contract.json does not declare for [fixture-deploy/Deploy_it] - declared in pipeline-stack.ts but not in pipeline-contract.json: deploy the stack (./deploy/pipeline/deploy.sh) then add it to the contract, or make the read tolerate absence (${DEPLOY_PREAPPROVED:-})` |
| `regression-576-fixed` | same + contract deploy entry gains DEPLOY_PREAPPROVED `{source: action, absence: tolerated}` | | 0 | `OK: pipeline contract - 2 buildspecs, 6 provided vars` |
| `contract-not-in-stack` | buildspec.yml entry gains `INVENTED_ARG` (project) | | 1 | `FAIL: pipeline-contract.json declares INVENTED_ARG for buildspec.yml but stack.txt provides it to none of [fixture-build, Build_and_gate] - fix: remove it from the contract or add it to the stack (which is a HANDOFF)` |
| `namespace-not-exported` | buildspec.yml exports `SOMETHING_ELSE` instead | | 1 | `FAIL: stack.txt:29 references #{BuildVars.DEPLOY_PREAPPROVED} but buildspec.yml env.exported-variables does not export DEPLOY_PREAPPROVED - fix: add DEPLOY_PREAPPROVED to exported-variables or remove the reference` |
| `namespace-not-declared` | contract namespaces = `{codepipeline: builtin}` only | | 1 | `FAIL: stack.txt:29 references #{BuildVars.DEPLOY_PREAPPROVED} but BuildVars is not in pipeline-contract.json namespaces - fix: add the namespace (exporter + action, or builtin: true) or remove the reference` |
| `exporter-action-mismatch` | namespaces.BuildVars.action = `Deploy_it` | | 1 | `FAIL: stack.txt declares variablesNamespace "BuildVars" on action Build_and_gate but pipeline-contract.json says action Deploy_it - fix: correct namespaces["BuildVars"].action` |
| `fail-closed-missing-contract` | contract.json deleted | | 2 | `contract file missing` |
| `fail-closed-unparseable-json` | contract.json = `{ not json` | | 2 | `unparseable JSON` |
| `fail-closed-buildspec-missing` | buildspec.yml deleted | | 2 | `buildspec file missing` |
| `fail-closed-missing-stack` | stack.txt deleted | | 2 | `stack file missing` |
| `fail-closed-unknown-top-key` | top-level `"extra": "x"` | | 2 | `unknown top-level key 'extra'` |
| `fail-closed-unknown-entry-key` | `provides.AWS_REGION_HUB.bogus = 1` | | 2 | `unknown key 'bogus'` |
| `fail-closed-bad-absence` | `absence: "maybe"` | | 2 | `absence must be "required" or "tolerated"` |
| `fail-closed-unknown-buildspec-arg` | none | `--buildspec nope.yml` | 1 | `FAIL: nope.yml has no contract entry in pipeline-contract.json buildspecs - fix: add buildspecs["nope.yml"] (providedBy + provides) or remove the file` |
| `fail-closed-globbed-not-in-contract` | extra file `buildspec-extra.yml` in the case dir | | 1 | `FAIL: buildspec-extra.yml has no contract entry in pipeline-contract.json buildspecs - fix:` |
| `fail-closed-multiline-quoted-scalar` | `- "echo this scalar` / `  continues here"` | | 2 | `unsupported multi-line quoted scalar at` |
| `fail-closed-unterminated-heredoc` | `- \|` / `cat <<'EOF'` / `never closed` | | 2 | `unterminated heredoc <<EOF` |
| `fail-closed-stack-unknown-spread` | stack `...otherVars,` | | 2 | `spread of otherVars in environmentVariables block` |
| `fail-closed-stack-two-commons` | a second `const commonEnvVars = {...}` | | 2 | `expected exactly one \`const commonEnvVars = {\` block, found 2` |
| `fail-closed-stack-nonliteral-projectName` | `projectName: name` | | 2 | `projectName is not a string literal` |
| `fail-closed-stack-env-identifier` | `environmentVariables: someOtherVars,` | | 2 | `environmentVariables bound to 'someOtherVars'` |
| `tolerant-declared-pass` | stack build block gains `EXTRA_DECLARED`; contract gains it (project, tolerated); buildspec reads `${EXTRA_DECLARED:-none}` | | 0 | `OK: pipeline contract - 2 buildspecs, 6 provided vars` |
| `builtin-pass` | buildspec reads `${CODEBUILD_RESOLVED_SOURCE_VERSION:-} $CODEBUILD_BUILD_ID` | | 0 | `OK:` |
| `lowercase-pass` | buildspec reads `$rc ${attempt} $Account $lower_case` | | 0 | `OK:` |
| `self-referential-read` | `UNDECL_SELF="${UNDECL_SELF:-default}"` then `echo "$UNDECL_SELF"` | | 1 | `FAIL: buildspec.yml:14 reads UNDECL_SELF which pipeline-contract.json does not declare for [fixture-build/Build_and_gate] - fix: if the deployed stack provides it (./deploy/pipeline/deploy.sh has run), add it under buildspecs["buildspec.yml"].provides; otherwise make the read tolerate absence or drop it, or add it to allow with a reason` |
| `self-referential-events-table` (companion) | `GIT_SHA=abc` / `GIT_SHA="$GIT_SHA" EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}" \` / `python3 deploy.py` | | 1 | `reads EVENTS_TABLE which pipeline-contract.json does not declare for [fixture-build/Build_and_gate] - fix:` (GIT_SHA not reported) |
| `self-referential-defined-elsewhere-pass` | `X_VAR=1` then `X_VAR="$(printf %s "$X_VAR" \| cut -c1-12)"` | | 0 | `OK:` |
| `comment-not-definition` | YAML comment `# UNDECL_C=true ...`, bash comment `# UNDECL_C=1`, then `echo "$UNDECL_C"` | | 1 | `reads UNDECL_C which pipeline-contract.json does not declare` |
| `quoted-scalar-definition` | `- "QS_VAR=\"$(aws sts get-caller-identity --query Account --output text)\""` then `- "echo $QS_VAR"` | | 0 | `OK:` |
| `heredoc-literal` | `python3 - <<'PY' \|\| true` / `print('$UNDECL_H')` / `PY` | | 0 | `OK:` |
| `heredoc-unquoted-read-counts` | `cat <<EOF` / `$UNDECL_H` / `EOF` | | 1 | `reads UNDECL_H which pipeline-contract.json does not declare` |
| `heredoc-unquoted-body-not-definition` | `cat <<EOF` / `UNDECL_H2=1` / `EOF` / `echo "$UNDECL_H2"` | | 1 | `reads UNDECL_H2 which pipeline-contract.json does not declare` |
| `escaped-dollar` | `- "echo \\$UNDECL_E"` and `printf '\$UNDECL_E2'` | | 0 | `OK:` |
| `double-backslash-dollar-reads` | `echo "\\\\$UNDECL_E3"` (a literal backslash then `$UNDECL_E3`) | | 1 | `reads UNDECL_E3 which pipeline-contract.json does not declare` |
| `undeclared-plain-read` | temp copy of buildspec.yml + `- "echo \"$FOO_BAR\""` | `--buildspec <tmp>/buildspec.yml` | 1 | `<tmp>/buildspec.yml:13 reads FOO_BAR which pipeline-contract.json does not declare for [fixture-build/Build_and_gate] - fix:` ... ending in ` (contract entry buildspec.yml)` |
| `stack-extra-not-in-contract-pass` | stack build block gains `NOT_YET_DEPLOYED` (contract unchanged, nobody reads it) | | 0 | `OK:` |
| `unknown-provider` | providedBy gains `Ghost_action` | | 1 | `FAIL: buildspec.yml providedBy names Ghost_action, which is neither a projectName nor an actionName in stack.txt - fix: correct the name or remove it from providedBy` |
| `source-mismatch` | AWS_REGION_HUB `source: project` | | 1 | `FAIL: pipeline-contract.json says AWS_REGION_HUB source=project for buildspec.yml but stack.txt declares it as common for fixture-build - fix: set source to common` |
| `provider-binding` | deploy.yml providedBy = `[fixture-deploy]` | | 1 | `FAIL: stack.txt action Deploy_it (project fixture-deploy) runs deploy.yml but is missing from its providedBy - fix: add Deploy_it to buildspecs["deploy.yml"].providedBy` |
| `provider-binding-wrong-buildspec` | stack `fromSourceFilename("other.yml")` on fixture-build | | 1 | `FAIL: buildspec.yml providedBy project fixture-build runs other.yml, not this buildspec - fix: move fixture-build to the entry for other.yml or fix the stack's fromSourceFilename` |
| `missing-provider` | buildspec.yml providedBy = `[Build_and_gate]` | | 1 | `FAIL: stack.txt project fixture-build runs buildspec.yml but is missing from its providedBy - fix: add fixture-build to buildspecs["buildspec.yml"].providedBy` (plus the P2b line and three P3a lines, all sorted) |
| `single-quoted-read-counts` | `echo '$UNDECL_SQ'` | | 1 | `FAIL: buildspec.yml:14 reads UNDECL_SQ which pipeline-contract.json does not declare` |
| `trap-body-read` | `trap 'echo $UNDECL_T' EXIT` | | 1 | `FAIL: buildspec.yml:14 reads UNDECL_T which pipeline-contract.json does not declare` |
| `bare-export-is-read` | `export UNDECL_X` | | 1 | `FAIL: buildspec.yml:14 reads UNDECL_X which pipeline-contract.json does not declare` |
| `bare-export-of-provided-pass` | `export AWS_REGION_HUB ARTIFACT_BUCKET ECR_REPO` | | 0 | `OK:` |
| `declare-without-eq-is-definition` | `declare -A DECL_MAP` / `local LOC_V` / `echo "${DECL_MAP[x]:-} $LOC_V"` | | 0 | `OK:` |
| `read-for-select-definitions` | `while IFS=$'\t' read -r K1 K2 <&3; do echo $K1 $K2; done 3< f` / `read -d '' -t 5 K3 <<<x; for K4 in a b; do echo $K3 $K4; done` / `mapfile -t K5 < f; echo ${K5[0]}` | | 0 | `OK:` |
| `command-prefix-and-build-arg` | `PFX_A=1 PFX_B="$AWS_REGION_HUB" node x.js` / `docker build --build-arg UNDECL_BA="${UNDECL_BA:-}" .` | | 1 | `FAIL: buildspec.yml:15 reads UNDECL_BA which pipeline-contract.json does not declare` (PFX_* not reported) |
| `strict-absence-bare-read` | contract ECR_REPO `absence: tolerated`; buildspec adds `- "echo $ECR_REPO"` | `--strict-absence` | 1 | `FAIL: buildspec.yml:13 reads ECR_REPO bare but it is marked absence=tolerated - fix: read it as ${ECR_REPO:-} because the deployed pipeline may not provide it yet` |
| `strict-absence-same-fixture-passes-without-flag` | same fixture | | 0 | `OK:` |
| `strict-absence-per-provider` | stack Deploy_it block gains `DEPLOY_ONLY`; contract deploy entry gains it (action); deploy.yml adds `- "echo $DEPLOY_ONLY"` | `--strict-absence` | 1 | `FAIL: deploy.yml:8 reads DEPLOY_ONLY bare but it is not provided by fixture-deploy - fix: read it as ${DEPLOY_ONLY:-} because the deployed pipeline may not provide it yet` |
| `explain-format` | none | `--explain` | 0 | `EXPLAIN: buildspec.yml providedBy=[Build_and_gate,fixture-build] provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,ECR_REPO] consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,ECR_REPO] allow=[] builtin=[] defined=[DEPLOY_PREAPPROVED]` |
| `determinism` | `- "echo $ZZ_UNDECL $AA_UNDECL"` | run twice | 1 | stdout+stderr byte-identical; `FAIL: buildspec.yml:13 reads AA_UNDECL which pipeline-contract.json does not declare` precedes the ZZ_UNDECL line |

Non-fixture pins in the same test file:

- lockstep: both `.github/workflows/ci.yml` and `deploy/pipeline/buildspec-ci.yml`
  contain `./scripts/check-pipeline-contract.sh`; both pytest lists contain
  `deploy/pipeline/test_check_pipeline_contract.py` (model:
  `test_buildspec_ci_exit_codes.py::test_this_file_runs_in_ci`, 119-133);
- wrapper mode: `os.stat(wrapper).st_mode & stat.S_IXUSR` (no git subprocess
  needed; `git ls-files -s` is the manual check);
- stdlib/offline source pin: the guard source contains none of `boto3`,
  `subprocess`, `urllib`, `requests`, `import yaml`, `os.environ`;
- contract-stack-path pin: shipped contract `stack ==
  "deploy/pipeline/lib/pipeline-stack.ts"` and the shipped `$comment` equals the
  sentence in 1.2 verbatim;
- head `--explain` pin: the three EXPLAIN lines in 4.12 / appendix 12.2, exact
  (consumed/allow/builtin sets);
- head `--strict-absence` pin: exit 1, and the SET of reported (file, var) pairs
  parsed from the FAIL lines equals `{("deploy/pipeline/buildspec-ci.yml",
  "ECR_REPO")}` - the file and the variable, NOT the line numbers. Rationale: the
  finding in section 8 is a property of the ci buildspec (a bare ECR_REPO read
  inside the BUILD_APP_IMAGE block), and pinning 236/294 would make every
  unrelated edit above that block break the test; a new bare read of a different
  var, or the same finding moving to another file, still fails the pin.

Budget: the prototype battery of 55 cases (each run twice as a subprocess for
the determinism check, 110 runs) completes in about 5 s; the pytest file must
stay under 30 s.

---

## 8. FR-10 decision (D13): required vs tolerated absence

Ships as: the OPTIONAL `absence` field (schema-validated) and rule A1, enforced
ONLY behind `--strict-absence`, which neither CI rail passes in this PR.

Under `--strict-absence`, for each `provides` var that the buildspec reads and
does not define: if the entry is `tolerated`, or the var is not in the effective
env of EVERY provider in `providedBy` (3.1), then every read must be tolerant
(`${X:-..}`, `${X-..}`, `${X:+..}`, `${X+..}`, or a bare `export X`); a bare
`$X` / `${X}` / `${X#..}` read is violation A1 with the fix "read it as `${X:-}`
because the deployed pipeline may not provide it yet".

At HEAD `--strict-absence` reports exactly:

```
FAIL: deploy/pipeline/buildspec-ci.yml:236 reads ECR_REPO bare but it is not provided by agentcore-hub-ci - fix: read it as ${ECR_REPO:-} because the deployed pipeline may not provide it yet
FAIL: deploy/pipeline/buildspec-ci.yml:294 reads ECR_REPO bare but it is not provided by agentcore-hub-ci - fix: read it as ${ECR_REPO:-} because the deployed pipeline may not provide it yet
```

Both reads sit inside the `BUILD_APP_IMAGE` block (223-337), which only runs on
`agentcore-hub-build`, where ECR_REPO IS provided; the PR-check project never
enters it. This is correct code and a known, deliberate follow-up (either mark
ECR_REPO `tolerated` on the ci entry with a comment, or leave strict mode off).
It is NOT a defect of this PR, and default mode MUST pass HEAD - which is why A1
is opt-in. The initial contract marks DEPLOY_PREAPPROVED (both deploy buildspecs)
and EVENTS_TABLE as `tolerated`; every other entry omits the field.

---

## 9. Docs plan (FR-9)

### 9.1 `DEPLOY.md`

(a) Extend the "Pipeline mode" callout (lines 13-17) with one sentence after line
17, inside the blockquote:

```
> What the pipeline provides to those buildspecs is declared in
> `deploy/pipeline/pipeline-contract.json` and enforced by
> `scripts/check-pipeline-contract.sh` (see "What the pipeline provides to its
> buildspecs (the arg contract)" below).
```

(b) New subsection after the handoff table's closing paragraph (lines 342-345),
before `## Model bump` (currently line 347), titled
`### What the pipeline provides to its buildspecs (the arg contract)`:

```
### What the pipeline provides to its buildspecs (the arg contract)

The CodeBuild projects and CodePipeline actions in
`deploy/pipeline/lib/pipeline-stack.ts` provide environment variables; the three
buildspecs consume them. `deploy/pipeline/pipeline-contract.json` records, per
buildspec, which variables the DEPLOYED pipeline provides (and who provides
them), and `scripts/check-pipeline-contract.sh` (CI and the Build stage) fails on
any buildspec read the contract does not cover.

The rule: adding an entry to pipeline-contract.json asserts the deployed pipeline
provides it - run ./deploy/pipeline/deploy.sh first (or in the same release) - or
the consuming buildspec must tolerate absence. The check is deliberately
asymmetric. An entry must exist in the stack source (the contract cannot invent
an argument), but a stack-source argument missing from the contract is allowed:
it means "declared in source, not yet confirmed deployed", and a buildspec that
reads it fails CI until the contract is advanced. That is the gap PR #576 fell
into: the stack source and the buildspecs agreed, the stack had not been
redeployed (a HANDOFF), CodePipeline resolved the new `#{BuildVars.DEPLOY_PREAPPROVED}`
to empty, and every `main` deploy failed at `PRE_BUILD` until PR #579 made the
gate tolerate empty and a human ran `deploy.sh`.

Reads of names the buildspec defines itself, `CODEBUILD_*` builtins, and names in
the contract's `allow` map (with a one-line reason each) are not pipeline
arguments and pass. Run `./scripts/check-pipeline-contract.sh --explain` to see
what each buildspec consumes.
```

### 9.2 `deploy/pipeline/README.md` Files table (lines 107-120)

Add after the `buildspec-deploy.yml` row (line 114) a row for the third buildspec
that the table currently lacks, then the two new files:

```
| `buildspec-runtime-images.yml` | Deploy stage (parallel, arm64): rebuild changed fleet/coding runtime images, image-only `UpdateAgentRuntime` |
| `pipeline-contract.json` | the DECLARED pipeline-arg contract: per buildspec, the env vars the deployed stack provides (project/action, since, comment, optional absence) plus the inline `allow` map; advanced by a human after `deploy.sh`, never generated |
| `check-pipeline-contract.py` | the guard behind `scripts/check-pipeline-contract.sh` (both CI rails): textual stack parse + buildspec read scan, asymmetric parity (contract must exist in stack source; stack-only args fail any read until the contract is advanced); stdlib only |
| `test_check_pipeline_contract.py` | pytest battery for the guard + fixtures under `fixtures/pipeline-contract/<case>/` (`stack.txt`, `contract.json`, `buildspec.yml`, `deploy.yml`); runs in both pytest lists (ci.yml and buildspec-ci.yml) |
```

### 9.3 `docs/architecture.md` DL-028 (824-853)

Append one paragraph after the "Rollout contract" text, i.e. after line 853 and
before the `---` at 855:

```
**Guarded since TEAM-4563/TEAM-4579.** The two-clock gap above is now caught in CI: `deploy/pipeline/pipeline-contract.json` declares, per buildspec, the env vars the *deployed* stack provides, and `scripts/check-pipeline-contract.sh` fails any buildspec read the contract does not cover - including a var that pipeline-stack.ts already declares in source (the #576 shape), with the fix "deploy the stack, then advance the contract, or read it as `${X:-}`". The contract is a human-advanced declaration, never generated from the stack, precisely because a stack-derived contract would have passed #576.
```

### 9.4 `docs/pipeline/design.md`, "The deploy gate is human-only" (180+)

Insert after the TEAM-4527 "Empty is the unwired stack, not garbage" paragraph
(lines 255-271), before line 273 ("Three checkpoints ..."), at the same
indentation as that paragraph:

```
   **The arg contract (TEAM-4563 / TEAM-4579).** What this incident generalises to
   is "a buildspec reads a variable the stack source declares but the deployed
   stack does not yet provide". `deploy/pipeline/pipeline-contract.json` is the
   declared, human-advanced record of what the deployed pipeline provides to each
   buildspec, and `scripts/check-pipeline-contract.sh` (CI + Build stage) fails a
   read the contract does not cover. It is asymmetric on purpose: a contract entry
   must exist in `pipeline-stack.ts` (the contract cannot invent an argument), but a
   stack-source argument absent from the contract is legal and means "not yet
   confirmed deployed" - the read fails until `deploy.sh` has run and the entry is
   added, or the buildspec reads it as `${X:-}`. Nothing is generated from the
   stack: a stack-derived contract would have passed #576.
```

---

## 10. Open questions resolved (requirements section 8, items 1-10)

| # | Open question | Resolution |
|---|---|---|
| 1 | Exact regex for the stack's `environmentVariables` blocks (`environmentVariables: {` ... matching `}` with nested `{ value: ... }` and `//` comments; recommended: strip `//` comments line-wise outside string literals, brace-depth walk from each `environmentVariables:` / `commonEnvVars` occurrence, `^\s*([A-Z][A-Z0-9_]*)\s*:` at depth 1 plus `\.\.\.commonEnvVars` expansion, attribute to the nearest preceding `projectName:` / `actionName:`, pin with head-pass). | Section 2, refined beyond the recommendation because line-wise `//` stripping is unsafe here: a char-level state machine strips `//` and `/* */` while honouring `"..."`, `'...'` and template literals with `${}` nesting (2.1), a masked copy blanks string contents so `{`/`}` inside `"#{BuildVars.X}"` and `/*` inside `` `${bucketArn}/config/*` `` cannot confuse the brace walk (2.2), the anchors are `\bconst\s+commonEnvVars\b[^=]*=\s*\{` (exactly once) and `\benvironmentVariables\s*:\s*` followed by `{` or by the identifier `commonEnvVars` (the `environmentVariables: commonEnvVars` case at line 256; any other identifier is exit 2), keys are the depth-1 lines matching `^\s*(?:\.\.\.(\w+)\|([A-Za-z_]\w*)\|"([^"]+)")\s*(?::\|,\|$)` with `...commonEnvVars` expanded and `[A-Z][A-Z0-9_]*` keys taken as vars (2.4), attribution is nearest-preceding `projectName:`/`actionName:` (2.5), pinned by `head-pass` and the 2.7 table (D19). |
| 2 | Per-action vs per-project modelling (recommended: flat list of names, `providedBy` lists both for a deploy buildspec, each `provides` entry records `source` common/project/action, MUST check against the union). | Adopted as D2: flat `providedBy` of projectNames and actionNames, deploy buildspecs list project + action, `source` is required and validated against the stack (P3b). The consumption check is against the UNION of `provides` (D18); D20 adds the binding checks (P1, P2a-d) so a provider cannot be listed on the wrong buildspec or be forgotten. |
| 3 | EVENTS_TABLE shell default (`${EVENTS_TABLE:-agentcore-hub-events}`, runtime-images 134: both provided by the stack and tolerant; the contract stores names only, never the default value). | Declared in the runtime-images entry with `"absence": "tolerated"` and a comment saying the buildspec defaults it; the value is never stored (names only, 1.1). D9 makes the command-prefix form `EVENTS_TABLE="${EVENTS_TABLE:-...}"` a self-referential READ, not a definition, so it is CONSUMED and covered (4.11, 4.12). |
| 4 | buildspec-ci.yml under two providers (AC-4.7 / AC-10.2): ship per-provider strictness by default? | No. Default mode checks CONSUMED against the union of `provides` (AC-4.7); the per-provider refinement exists only under `--strict-absence` (D13, rule A1, 3.1), which at HEAD reports the two bare ECR_REPO reads at ci.yml 236 and 294 inside the BUILD_APP_IMAGE block (section 8). Default mode must and does pass HEAD. |
| 5 | Single-quoted strings (bash does not expand inside `'...'`, but `trap` / `bash -c` bodies do; recommended: skip by default; must document and pin). | Rejected in favour of D4: single quotes are TRANSPARENT for reads because `trap '...'`, `bash -c '...'`, `sh -c`, `eval`, `xargs` and `find -exec` bodies expand later and do read env; skipping would be a silent miss of the #576 class, while a literal `'$UPPER'` is a loud false positive fixed by `allow` or a rewrite. JMESPath and awk bodies at HEAD contain no `$NAME`. Pinned by `single-quoted-read-counts` and `trap-body-read` (7.3). |
| 6 | `#{...}` inside buildspec comments (deploy.yml 48). | D5/D6: `#{` never starts a comment, and `#{Ns.VAR}` tokens are extracted only from comment-stripped text, so the `# ... "#{BuildVars...}" ...` comment at deploy.yml 48 is spaces before extraction. Pinned by `head-pass`: zero tokens in the buildspecs, 3 in the stack (`3 namespace refs checked`). |
| 7 | Where the allowlist lives (inline `allow` vs a sibling `.allow` file). | Inline `allow` object in the contract, one reason per name, schema-enforced; no sibling file; the script hardcodes no names (D1). |
| 8 | Line numbers in messages must be buildspec FILE lines (carry through comment stripping by replacing text with spaces, keeping newlines). | Every transform is length- and newline-preserving: YAML classification keeps one bash-view line per file line, comment stripping (D5) and heredoc blanking (D7) replace text with spaces, escape removal (D17) replaces two chars with two spaces, so `read_text` and `walk_text` share offsets and `line = count("\n") + 1` is the file line (4.1). Verified by the 4.11 table and the fixture line numbers in 7.3. |
| 9 | CRLF in fixtures. | D16: every file is decoded as strict UTF-8 (decode error -> exit 2) and `\r\n` is normalised to `\n` before any pass, for the stack, the contract and the buildspecs alike, so a CRLF fixture behaves exactly like an LF one. |
| 10 | Future stack-side generation (an `--emit-from-stack` helper that must NOT become the source of truth). | D22: the flag name is reserved now (exit 2 "reserved and not implemented"); a future helper may print the stack-source view as JSON for diffing but must never write the contract or be treated as the source of truth, because a stack-derived contract would have passed #576 (0.2). |

---

## 11. Implementation notes for the developer

### 11.1 Files and budgets

| File | Budget |
|---|---|
| `deploy/pipeline/pipeline-contract.json` | the JSON in 1.2 verbatim (about 140 lines) |
| `deploy/pipeline/check-pipeline-contract.py` | about 900-1100 lines including docstrings and blank lines (the prototype is 1120); one file, no package |
| `scripts/check-pipeline-contract.sh` | 6.1 verbatim, 100755 |
| `deploy/pipeline/test_check_pipeline_contract.py` | about 350 lines; fixtures are files, not strings, except the temp-copy case |
| `deploy/pipeline/fixtures/pipeline-contract/*` | 50-55 case dirs, 3-4 small files each |
| docs | 9.1-9.4 |

### 11.2 Function decomposition of `check-pipeline-contract.py`

```
class Infra(Exception)                              # exit 2 carrier
strip_ts_comments(src, path) -> (code, masked)      # 2.1 + 2.2 state machine
brace_walk(masked, open_idx, path) -> close_idx     # 2.3
parse_stack(path) -> dict                           # 2.3-2.6 (anchors, block_keys, attribution)
load_text(path) -> str                              # strict UTF-8, CRLF
classify_yaml_lines(text, path) -> (bash_lines, env_defined, exported)   # 4.2
strip_bash_comments(text) -> text                   # 4.3
blank_heredocs(text, path) -> (read_base, walk_text)                     # 4.4
remove_escapes(text) -> text                        # 4.5
extract_reads(read_text, lo, hi) -> [(name, off, form)]                  # 4.6
consume_word(text, i, hi) -> (end, subs)            # 4.7
scan_statements(walk_text, read_text, lo, hi, defs) # 4.7-4.9 (with _assign for D9)
scan_buildspec(path) -> dict                        # the pass pipeline, returns reads/defined/exported/tokens
load_contract(path) -> dict                         # 1.1 schema (validate inline or as validate_schema)
effective_vars(stack, provider) -> {var: source}    # 3.1
check_parity(contract, contract_path, stack, targets, explain, strict) -> exit code   # section 3, 4.10, 4.13
main(argv) -> int                                   # 5.4 CLI (--root default Path(__file__).resolve().parents[2]), D11 resolution, D15 ordering
```

### 11.3 Compatibility and style

- Python 3.9: no `match` statements, no `X | Y` unions, no `str.removeprefix`
  reliance beyond 3.9; f-strings fine. Only `argparse, glob, json, re, sys` and
  `pathlib.Path` imported.
- All regexes exactly as written in sections 2 and 4 (they are the ones the
  prototype ran).
- Messages are built once per rule from the templates in sections 3 and 5.3;
  no em dashes anywhere (`-` only).
- `--root` defaults to `Path(__file__).resolve().parents[2]` (deploy/pipeline -> deploy -> repo root), exactly like `REPO = Path(__file__).resolve().parents[2]` in `test_preapproved_check.py`; `--contract` defaults to `<root>/deploy/pipeline/pipeline-contract.json`.
- Messages: the literal basenames `pipeline-contract.json` and `pipeline-stack.ts` appear in the fixed FR-6 phrases regardless of the paths passed; `<S>` and `<path>` print as given.
- Determinism: never iterate a set for output without `sorted()`.
- Performance: the whole thing is O(bytes); HEAD runs in 0.1 s.

---

## 12. Appendix: verified HEAD extraction and evidence

### 12.1 Provider table with line numbers

See 2.7. Summary counts: 4 projects, 5 actions, 17 (provider, var) pairs with a
source (3 common x 4 projects = 12, plus ECR_REPO x2, BUILD_APP_IMAGE,
NEXT_PUBLIC_PIPELINE_ENABLED, ECS_SERVICE_ARN, EVENTS_TABLE, DEPLOY_PREAPPROVED
x2 = 20 declarations); the contract's 17 "provided vars" is the count of
`provides` entries (6 + 6 + 5).

### 12.2 `--explain` at HEAD (`head-explain.txt`)

```
EXPLAIN: deploy/pipeline/buildspec-ci.yml providedBy=[Build_and_gate,agentcore-hub-build,agentcore-hub-ci] provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,BUILD_APP_IMAGE,ECR_REPO,EXPECTED_ACCOUNT_ID,NEXT_PUBLIC_PIPELINE_ENABLED] consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,BUILD_APP_IMAGE,ECR_REPO,NEXT_PUBLIC_PIPELINE_ENABLED] allow=[PLAYWRIGHT_BROWSERS_PATH] builtin=[CODEBUILD_RESOLVED_SOURCE_VERSION] defined=[ACCOUNT_ID,DEPLOY_PREAPPROVED,ECR_URI,FULL_SHA,GIT_SHA,IMAGE_DIGEST,LAST_DEPLOYED,LAST_RT,PLAYWRIGHT_BASE_URL,ZIP_ARGS]
EXPLAIN: deploy/pipeline/buildspec-deploy.yml providedBy=[Deploy_three_targets,agentcore-hub-deploy] provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,ECR_REPO,ECS_SERVICE_ARN,EXPECTED_ACCOUNT_ID] consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,ECR_REPO,ECS_SERVICE_ARN,EXPECTED_ACCOUNT_ID] allow=[] builtin=[] defined=[ACCOUNT_ID,AWS_REGION,DESC,DIR,DST,ECR_URI,ECS_CLUSTER,ECS_SVC,EXTRA,FILES,FN,GIT_SHA,HARNESS_SNAPSHOT_DIR,HNAME,HSCRIPT,IFS,IMAGE_DIGEST,KIND,LIVE_URL,NDEPLOY,NOTE,NPM,OPTIONAL,PIPELINE_MODE,PKGS,PREV_TASKDEF,PRIMARY,ROLLOUT,ROOT,SAME_IMAGE,SRC,STATUS,TASKDEF,URL]
EXPLAIN: deploy/pipeline/buildspec-runtime-images.yml providedBy=[Deploy_runtime_images,agentcore-hub-runtime-image-deploy] provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,EVENTS_TABLE,EXPECTED_ACCOUNT_ID] consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,DEPLOY_PREAPPROVED,EVENTS_TABLE,EXPECTED_ACCOUNT_ID] allow=[] builtin=[] defined=[ACCOUNT_ID,AWS_REGION,BUILT_REF,CTX,DIGEST,ECR_REG,GIT_SHA,IFS,IMG,KIND,NAME,PAIR,REF,REPO,RT_CHANGED,RT_SNAPSHOT_DIR,TAG]
OK: pipeline contract - 3 buildspecs, 17 provided vars, 3 namespace refs checked
```

### 12.3 Read occurrences per buildspec (name: lines; `t` = tolerant form, `e` = bare export)

buildspec-ci.yml: ACCOUNT_ID 236 265; ARTIFACT_BUCKET 271 319 331; AWS_REGION_HUB
236 264 265 271 295 319 331; BUILD_APP_IMAGE 223t 370t; CODEBUILD_RESOLVED_SOURCE_VERSION
278t 371t; DEPLOY_PREAPPROVED 369e 374 376 378e 380; ECR_REPO 236 294; ECR_URI 282
282; FULL_SHA 372 373; GIT_SHA 279 282 295 303 311; IMAGE_DIGEST 297 299 302 306 310;
LAST_DEPLOYED 320 320 321; LAST_RT 332 332 333; NEXT_PUBLIC_PIPELINE_ENABLED 281t;
PLAYWRIGHT_BROWSERS_PATH 86t 86 87 88 90; ZIP_ARGS 230.

buildspec-deploy.yml (pipeline args only): ACCOUNT_ID 73 74 96e 100; ARTIFACT_BUCKET
96e 206 207 211 214 217 219 229 230 253 282 346 347 368; AWS_REGION_HUB 96e 100 124
133 140 162 164 179 184 197 199 211 253 261 266 279 287 311 346 347 368;
DEPLOY_PREAPPROVED 68t; ECR_REPO 96e 100; ECS_SERVICE_ARN 96e 132t 133 139 139 260t
261 265 283t 287 306 306; EXPECTED_ACCOUNT_ID 73t 73 74.

buildspec-runtime-images.yml (pipeline args only): ACCOUNT_ID 48 49 90; ARTIFACT_BUCKET
75t 77; AWS_REGION_HUB 67 78 90 91 99 122 135; DEPLOY_PREAPPROVED 44t; EVENTS_TABLE
134t; EXPECTED_ACCOUNT_ID 48t 48 49.

### 12.4 Evidence for every cited line

`head-line-check.txt` (same directory) lists `path:line:text` for every line
number cited in this document, produced from HEAD `a0e4b90`.
