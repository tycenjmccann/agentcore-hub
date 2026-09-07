# Dead Code Sweep Findings — 2026-09-07

## 1. Header

repo: tycenjmccann/agentcore-hub
base SHA: 4633c010bdf895a8bea8ca53344ef5e32f037eff
branch: feature/TEAM-4203-code-sweeper
head: ce9ba186a09c5809db95675191ec18e7bc4c6dd2
date: 2026-09-07
ticket: TEAM-4203
epic: TEAM-4199
workflow: wf_1788776595965_oe5ded
prior sweep PR: #239

## 2. FR-0 install health

Node version: v20.19.2
knip version: 6.32.2
ts-prune --version result (ts-prune has no --version; this printed a scan line): playwright.config.ts:40 - default
depcheck version: 1.4.7

Binaries:
```text
depcheck
eslint
knip
next
ts-prune
tsc
vitest
```


npm ci root initial tail (.sweep-output/npm-ci-root.tail.txt):
```text
npm ERR! code EMFILE
npm ERR! syscall open
npm ERR! path /home/bedrock_agentcore/.npm/_cacache/index-v5/67/5e/e54df92ed7a98ac101755877b750a30fb3b2526095c8c89866546209a91e
npm ERR! errno -24
npm ERR! EMFILE: too many open files, open '/home/bedrock_agentcore/.npm/_cacache/index-v5/67/5e/e54df92ed7a98ac101755877b750a30fb3b2526095c8c89866546209a91e'

npm ERR! A complete log of this run can be found in:
npm ERR!     /home/bedrock_agentcore/.npm/_logs/2026-09-07T10_46_56_312Z-debug-0.log
```


npm ci root retry-1 exit/tail:
```text
232
npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.
npm WARN deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported
npm WARN deprecated @humanwhocodes/config-array@0.13.0: Use @eslint/config-array instead
npm WARN deprecated @humanwhocodes/object-schema@2.0.3: Use @eslint/object-schema instead
npm WARN deprecated glob@7.2.3: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me
npm WARN deprecated glob@10.3.10: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me
npm WARN deprecated eslint@8.57.1: This version is no longer supported. Please see https://eslint.org/version-support for other options.
npm ERR! code EMFILE
npm ERR! syscall open
npm ERR! path /home/bedrock_agentcore/.npm/_cacache/index-v5/99/ae/1e71be6b242b5cd45b4d0cfe5ae563f5ee9e672368d59683abd39fe5d986
npm ERR! errno -24
npm ERR! EMFILE: too many open files, open '/home/bedrock_agentcore/.npm/_cacache/index-v5/99/ae/1e71be6b242b5cd45b4d0cfe5ae563f5ee9e672368d59683abd39fe5d986'

npm ERR! A complete log of this run can be found in:
npm ERR!     /home/bedrock_agentcore/.npm/_logs/2026-09-07T10_51_19_182Z-debug-0.log
```


npm ci root retry-2 exit/tail:
```text
0

added 792 packages, and audited 793 packages in 3m

260 packages are looking for funding
  run `npm fund` for details

16 vulnerabilities (1 low, 5 moderate, 9 high, 1 critical)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```


npm --prefix mcp/hub ci tail:
```text

added 109 packages, and audited 110 packages in 16s

33 packages are looking for funding
  run `npm fund` for details

1 moderate severity vulnerability

To address all issues, run:
  npm audit fix

Run `npm audit` for details.
```


No Error loading / Cannot find module in the 11:01 tool outputs (the degraded 10:49 final-report run was voided and re-run):
```text
(no matches)
```

## 3. Scope decisions

deploy/pipeline was not treated as a root dead-code target: it is a separate CDK sub-project, excluded from the root tsconfig, dependencies are not installed in the root, and it is the pipeline shipping this PR.
demo/ was not swept for removal.
knip scope gap: knip.json entry/project globs do not cover deploy/**, evals/**, demo/**, or src/**/*.mjs with the same fidelity as test/build surfaces. vitest includes additional suites:
```text
23:    // deploy/telegram-bug-intake/**: the intake Lambda's AWS imports are mocked
27:      // Config-evals battery (evals/battery/): runner math, scoring, gate rules
29:      "evals/battery/**/*.test.ts",
32:      "deploy/lib/__tests__/**/*.test.ts",
34:      "deploy/telegram-bug-intake/**/*.test.mjs",
196:      "deploy/setup-pipeline-tools-lambda.test.mjs",
```

Therefore knip "unused file" verdicts in those areas carry no evidential weight.

## 4. Exact tool commands and exit codes

Commands actually represented by saved outputs:
```text
knip root: npx knip --no-exit-code --reporter symbols
knip mcp/hub: npx knip --no-exit-code --workspace mcp/hub
ts-prune root: npx ts-prune -p tsconfig.json
ts-prune mcp/hub: npx ts-prune -p mcp/hub/tsconfig.json
depcheck root: npx depcheck
depcheck mcp/hub: npx depcheck mcp/hub
```

Exit codes:
```text
knip-root: 0
knip-mcp-hub: 0
ts-prune-root: 0
ts-prune-mcp-hub: 0
depcheck-root: 255
depcheck-mcp-hub: 0
```

Raw candidate counts:
```text
knip-root: 238
knip-mcp-hub: 26
ts-prune-root: 401
ts-prune-mcp-hub: 30
depcheck-root: 7
depcheck-mcp-hub: 0
deduplicated: 544
```

mcp/hub knip proof: workspace analysed; unique /mcp/hub/src files listed in knip-mcp-hub-debug-full.txt: /bin/sh: 1: Syntax error: Unterminated quoted string.

## 5. RAW TOOL OUTPUT

### knip-root.txt
```text
Unused files (40)
demo/playwright.config.ts                                         
demo/playwright/playwright.config.ts                              
demo/playwright/test-popup.spec.ts                                
demo/playwright/test-s3-modal.spec.ts                             
demo/playwright/v4/check-layout.spec.ts                           
demo/playwright/v4/playwright-v4.config.ts                        
demo/playwright/v4/record-demo-v4.spec.ts                         
demo/playwright/v4/test-agent-streaming.spec.ts                   
demo/playwright/v4/test-lambda-orchestration.spec.ts              
demo/record.spec.ts                                               
deploy/pipeline/bin/pipeline.ts                                   
deploy/pipeline/harness-snapshot.mjs                              
deploy/pipeline/lib/pipeline-stack.ts                             
deploy/pipeline/restore-harness.mjs                               
deploy/routine-builder/setup-routine-builder.mjs                  
deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx     
deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx     
deploy/setup-builder-agent.mjs                                    
deploy/setup-tickets-lambda.mjs                                   
deploy/workflow-manager/setup-workflow-manager.mjs                
evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts
evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts  
evals/battery/fixtures/fix-race-condition-cas-003/store.ts        
lambda/agentcore-hub-jira/index.test.mjs                          
lambda/anomaly-watcher/detect.test.mjs                            
lambda/anomaly-watcher/index.test.mjs                             
lambda/builder-tools/index.mjs                                    
lambda/cost-report/index.test.mjs                                 
lambda/cost-report/pricing.test.mjs                               
lambda/orchestrator/model-router.mjs                              
lambda/orchestrator/model-router.test.mjs                         
lambda/prd-submitter/index.mjs                                    
lambda/routines-runner/index.mjs                                  
lambda/routines-runner/index.test.mjs                             
lambda/token-aggregator/index.mjs                                 
lambda/workflow-analyzer/index.mjs                                
scripts/backfill-workflow-tombstones.mjs                          
scripts/migrate-default-identity.mjs                              
src/components/workflow/PipelineVisualization.tsx                 
src/lib/models/harness-models.ts                                  
Unused devDependencies (2)
depcheck  package.json:69:6
ts-prune  package.json:75:6
Unlisted dependencies (4)
ajv/dist/2020              evals/battery/lib/cases.mjs:91:29           
ajv/dist/2020              evals/battery/lint-fixtures.mjs:53:27       
js-yaml                    lambda/anomaly-watcher/index.mjs:627:31     
@smithy/node-http-handler  lambda/orchestrator/agent-invoker.mjs:150:11
Unlisted binaries (2)
script  deploy/lib/__tests__/check-eval-gate.test.ts
setsid  deploy/lib/__tests__/check-eval-gate.test.ts
Unused exports (123)
PRICING_PER_MTOK                                          evals/battery/lib/agent-runner.mjs:22:14            
MAX_TURNS                                                 evals/battery/lib/agent-runner.mjs:37:14            
INFRA_RETRY_DELAY_MS                                      evals/battery/lib/agent-runner.mjs:85:14            
PERSONA_EVALUATOR_ID                                      evals/battery/lib/cases.mjs:12:14                   
batteryDir                                                evals/battery/lib/cases.mjs:15:14                   
loadCaseValidator                               function  evals/battery/lib/cases.mjs:87:17                   
loadBattery                                     function  evals/battery/lib/cases.mjs:100:17                  
defaultGitShow                                  function  evals/battery/lib/cases.mjs:276:17                  
MOCK_DEFAULT                                              evals/battery/lib/mock-transport.mjs:25:14          
SENSITIVE_EVALUATORS                                      evals/battery/lib/mock-transport.mjs:28:14          
GITHUB_OWNER_ALLOWLIST                                    evals/battery/lib/redact.mjs:14:14                  
JUDGE_MAX_TOKENS                                          evals/battery/lib/scoring.mjs:19:14                 
CUSTOM_EVALUATOR_ID                                       evals/battery/lib/scoring.mjs:21:14                 
builtinInstruction                              function  evals/battery/lib/scoring.mjs:83:17                 
HTTP_CONNECTION_TIMEOUT_MS                                evals/battery/lib/scoring.mjs:92:14                 
HTTP_REQUEST_TIMEOUT_MS                                   evals/battery/lib/scoring.mjs:93:14                 
SDK_MAX_ATTEMPTS                                          evals/battery/lib/scoring.mjs:94:14                 
SCALE                                                     evals/battery/lib/thresholds.mjs:5:14               
REWORK_FIX_KINDS              jiraCopy                    lambda/agentcore-hub-jira/fix-contract.mjs:72:14    
SPAWN_ORIGIN_KEYS             jiraCopy                    lambda/agentcore-hub-jira/fix-contract.mjs:86:14    
SPAWN_EXTRA_KEYS              jiraCopy                    lambda/agentcore-hub-jira/fix-contract.mjs:94:14    
EVIDENCE_SOURCES              jiraCopy                    lambda/agentcore-hub-jira/fix-contract.mjs:100:14   
CONTRACT_VERSION              jiraCopy                    lambda/agentcore-hub-jira/fix-contract.mjs:102:14   
SYSTEM_LABEL_PREFIXES         jiraCopy                    lambda/agentcore-hub-jira/fix-contract.mjs:109:14   
RESERVED_ADVISORY_LABEL       jiraCopy                    lambda/agentcore-hub-jira/fix-contract.mjs:138:14   
parseFixContractBlock         jiraCopy          function  lambda/agentcore-hub-jira/fix-contract.mjs:395:17   
advisoryIsReserved            jiraCopy          function  lambda/agentcore-hub-jira/fix-contract.mjs:506:17   
FIX_KINDS                     ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:66:14 
REWORK_FIX_KINDS              ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:72:14 
KIND_TO_ORIGIN_KEY            ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:76:14 
SPAWN_ORIGIN_KEYS             ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:86:14 
SPAWN_EXTRA_KEYS              ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:94:14 
EVIDENCE_SOURCES              ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:100:14
CONTRACT_VERSION              ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:102:14
SYSTEM_LABEL_PREFIXES         ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:109:14
RESERVED_ADVISORY_LABEL       ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:138:14
TICKET_KEY_RE                 ticketsCopy                 lambda/agentcore-hub-tickets/fix-contract.mjs:140:14
renderFixContractBlock        ticketsCopy       function  lambda/agentcore-hub-tickets/fix-contract.mjs:347:17
parseFixContractBlock         ticketsCopy       function  lambda/agentcore-hub-tickets/fix-contract.mjs:395:17
contractLabels                ticketsCopy       function  lambda/agentcore-hub-tickets/fix-contract.mjs:482:17
advisoryIsReserved            ticketsCopy       function  lambda/agentcore-hub-tickets/fix-contract.mjs:506:17
escapeJql                     ticketsCopy       function  lambda/agentcore-hub-tickets/fix-contract.mjs:574:17
VERIFIED_EVENT_TYPES                                      lambda/anomaly-watcher/bands-schema.mjs:28:14       
MAX_OPEN_PAIRS                                            lambda/anomaly-watcher/detect.mjs:30:14             
MAX_CONTRIBUTORS                                          lambda/anomaly-watcher/detect.mjs:32:14             
hourBucket                                      function  lambda/anomaly-watcher/detect.mjs:75:17             
ARTIFACT_CHAIN_GATE_MODES                                 lambda/orchestrator/artifact-chain.mjs:19:14        
CODE_REVIEWER_AGENT                                       lambda/orchestrator/artifact-chain.mjs:72:14        
PLAN_TICKET_TITLE                                         lambda/orchestrator/artifact-chain.mjs:73:14        
hasCascadeActivity                              function  lambda/orchestrator/cascade.mjs:685:17              
emitCascadeMetrics                              function  lambda/orchestrator/cascade.mjs:700:17              
emitMetrics                                     function  lambda/orchestrator/dead-session-detector.mjs:560:17
FIX_KINDS                     orchestratorCopy            lambda/orchestrator/fix-contract.mjs:66:14          
REWORK_FIX_KINDS              orchestratorCopy            lambda/orchestrator/fix-contract.mjs:72:14          
SPAWN_ORIGIN_KEYS             orchestratorCopy            lambda/orchestrator/fix-contract.mjs:86:14          
SPAWN_EXTRA_KEYS              orchestratorCopy            lambda/orchestrator/fix-contract.mjs:94:14          
EVIDENCE_SOURCES              orchestratorCopy            lambda/orchestrator/fix-contract.mjs:100:14         
CONTRACT_VERSION              orchestratorCopy            lambda/orchestrator/fix-contract.mjs:102:14         
SYSTEM_LABEL_PREFIXES         orchestratorCopy            lambda/orchestrator/fix-contract.mjs:109:14         
RESERVED_ADVISORY_LABEL       orchestratorCopy            lambda/orchestrator/fix-contract.mjs:138:14         
normalizeContractMode         orchestratorCopy  function  lambda/orchestrator/fix-contract.mjs:173:17         
contractLabels                orchestratorCopy  function  lambda/orchestrator/fix-contract.mjs:482:17         
advisoryIsReserved            orchestratorCopy  function  lambda/orchestrator/fix-contract.mjs:506:17         
sanitizeUserLabels            orchestratorCopy  function  lambda/orchestrator/fix-contract.mjs:526:17         
escapeJql                     orchestratorCopy  function  lambda/orchestrator/fix-contract.mjs:574:17         
emitReconcileMetrics                            function  lambda/orchestrator/reconcile-sweep.mjs:255:17      
checkRepoConfig                                 function  lambda/orchestrator/repo-check.mjs:100:23           
emitReviewCapMetrics                            function  lambda/orchestrator/review-cap.mjs:396:17           
emitReviewCapFailOpenMetrics                    function  lambda/orchestrator/review-cap.mjs:435:17           
MAX_SYNC_FIX_ROUNDS                                       lambda/orchestrator/sync-main.mjs:102:14            
_getWatchdogSource                              function  lambda/orchestrator/watchdog.mjs:45:17              
DEFAULT_FILE_CAP_BYTES                                    mcp/hub/src/cloud-code/artifacts.ts:41:14           
DEFAULT_TOTAL_CAP_BYTES                                   mcp/hub/src/cloud-code/artifacts.ts:42:14           
DEFAULT_FILE_COUNT_CAP                                    mcp/hub/src/cloud-code/artifacts.ts:43:14           
safeRelPath                                     function  mcp/hub/src/cloud-code/artifacts.ts:370:17          
parseRepo                                       function  mcp/hub/src/cloud-code/git.ts:53:17                 
normalizeCloneUrl                               function  mcp/hub/src/cloud-code/git.ts:65:17                 
canPushToOrigin                                 function  mcp/hub/src/cloud-code/git.ts:106:23                
slugForPath                                     function  mcp/hub/src/cloud-code/transcript.ts:18:17          
projectDirFor                                   function  mcp/hub/src/cloud-code/transcript.ts:22:23          
localTranscriptPath                             function  mcp/hub/src/cloud-code/transcript.ts:52:23          
RepoTargetSchema                                          mcp/hub/src/workflow/schemas.ts:3:14                
RepoConfigSchema                                          mcp/hub/src/workflow/schemas.ts:10:14               
IntakeSourceSchema                                        mcp/hub/src/workflow/schemas.ts:31:14               
ModelOverrideSchema                                       mcp/hub/src/workflow/schemas.ts:49:14               
PortedSessionSchema                                       mcp/hub/src/workflow/schemas.ts:62:14               
IntentBriefSchema                                         mcp/hub/src/workflow/schemas.ts:73:14               
WorkflowInputSchema                                       mcp/hub/src/workflow/schemas.ts:82:14               
RoutineScheduleSchema                                     mcp/hub/src/workflow/schemas.ts:132:14              
RoutineInputTemplateSchema                                mcp/hub/src/workflow/schemas.ts:140:14              
CLI_BRAND                                                 src/components/cloud-code/CliBrand.tsx:9:14         
getMemoryMapping                                function  src/lib/agentcore-sdk.ts:94:17                      
getLogsClient                                   function  src/lib/agentcore-sdk.ts:141:17                     
authDisabled                                    function  src/lib/auth/identity.ts:50:17                      
authMode                                        function  src/lib/auth/resolver.ts:14:17                      
CD_REGISTRY_KEY                                           src/lib/cd-registry.ts:46:14                        
invalidateCache                                 function  src/lib/client-cache.ts:75:17                       
DEFAULT_SCOPE                                             src/lib/cloud-code/config-store.ts:47:14            
secretIdFor                                     function  src/lib/connectors/secrets.ts:17:17                 
readRegistry                                    function  src/lib/connectors/store.ts:23:23                   
TOOL_ICON_MAP                                             src/lib/pipeline-config.ts:83:14                    
PHASE_DISPLAY_META                                        src/lib/pipeline-config.ts:126:14                   
PIPELINE_PHASES                                           src/lib/pipeline-config.ts:447:14                   
scheduleNameFor                                 function  src/lib/routines/schedule.ts:40:17                  
DEFAULT_USER_ID                                           src/lib/routines/store.ts:23:10                     
DEFAULT_TENANT_ID                                         src/lib/routines/store.ts:23:27                     
getRoutine                                      function  src/lib/routines/store.ts:37:23                     
formatDuration                                  function  src/lib/utils.ts:8:17                               
truncate                                        function  src/lib/utils.ts:15:17                              
redactUrl                                                 src/lib/workflow/intake.ts:19:10                    
JIRA_STATUS_TO_INTERNAL                                   src/lib/workflow/jira-client.ts:11:14               
INTERNAL_STATUS_TO_JIRA                                   src/lib/workflow/jira-client.ts:25:14               
FLEET_KPIS                                                src/lib/workflow/performance.ts:83:14               
BASELINE_DAYS                                             src/lib/workflow/performance.ts:101:14              
BASELINE_MIN                                              src/lib/workflow/performance.ts:102:14              
quantile                                        function  src/lib/workflow/performance.ts:113:17              
getPath                                         function  src/lib/workflow/performance.ts:154:17              
isValidCard                                     function  src/lib/workflow/performance.ts:217:17              
loadRoster                                      function  src/lib/workflow/roster-loader.ts:22:23             
INTAKE_SOURCE_TYPES                                       src/lib/workflow/source-shape.ts:29:14              
sdlcFrameworkForDef                             function  src/lib/workflow/workflow-defs.ts:280:17            
isHumanAssignee                                 function  src/lib/workflow/workflow-defs.ts:285:17            
writeArtifact                                   function  src/lib/workflow/workspace.ts:36:23                 
Unused exported types (63)
ArtifactKind            type       mcp/hub/src/cloud-code/artifacts.ts:45:13        
ArtifactCandidate       interface  mcp/hub/src/cloud-code/artifacts.ts:47:18        
ServerCategory          type       mcp/hub/src/cloud-code/cli-config.ts:26:13       
ServerTransport         type       mcp/hub/src/cloud-code/cli-config.ts:27:13       
ClassifiedServer        interface  mcp/hub/src/cloud-code/cli-config.ts:36:18       
StreamStatus            type       src/components/workflow/useWorkflowStream.ts:6:13
ModuleId                type       src/config/modules.ts:28:13                      
RegistryAuthorizerType  type       src/lib/agentcore-sdk.ts:910:13                  
ConnectorStatus         type       src/lib/connectors/types.ts:33:13                
PipelinePhaseId         type       src/lib/pipeline-config.ts:93:13                 
PipelineIdentityItem    interface  src/lib/pipeline-config.ts:99:18                 
PipelineConfigItem      interface  src/lib/pipeline-config.ts:104:18                
PipelineDisplayItem     interface  src/lib/pipeline-config.ts:109:18                
PipelineAgentConfig     interface  src/lib/pipeline-config.ts:244:18                
CiBuildSummary          interface  src/lib/pipeline/status.ts:23:18                 
StageState              interface  src/lib/pipeline/status.ts:32:18                 
RoutineRepoConfig       interface  src/lib/routines/types.ts:19:18                  
RoutineLastRun          interface  src/lib/routines/types.ts:48:18                  
AnalysisTrigger         type       src/lib/workflow/analysis-types.ts:13:13         
FindingKind             type       src/lib/workflow/analysis-types.ts:19:13         
FindingSeverity         type       src/lib/workflow/analysis-types.ts:20:13         
RecommendationPriority  type       src/lib/workflow/analysis-types.ts:21:13         
RecommendationType      type       src/lib/workflow/analysis-types.ts:22:13         
PhaseMetric             interface  src/lib/workflow/analysis-types.ts:29:18         
AgentTaskMetric         interface  src/lib/workflow/analysis-types.ts:37:18         
HumanReviewMetric       interface  src/lib/workflow/analysis-types.ts:48:18         
FixTicketEntry          interface  src/lib/workflow/analysis-types.ts:67:18         
ChangeRequestCycle      interface  src/lib/workflow/analysis-types.ts:84:18         
ManagerIntervention     interface  src/lib/workflow/analysis-types.ts:91:18         
WorkflowMetrics         interface  src/lib/workflow/analysis-types.ts:98:18         
AnalysisScores          interface  src/lib/workflow/analysis-types.ts:139:18        
AnalysisTrend           interface  src/lib/workflow/analysis-types.ts:165:18        
WorkflowCommand         interface  src/lib/workflow/command-queue.ts:23:18          
CompletionRecord        interface  src/lib/workflow/completion-evidence.ts:21:18    
SourceOutcome           type       src/lib/workflow/intake.ts:75:13                 
LookupImpl              type       src/lib/workflow/intake.ts:104:13                
ModelProvider           type       src/lib/workflow/model-config.ts:18:13           
ModelOptionBase         interface  src/lib/workflow/model-config.ts:26:18           
BedrockModelOption      interface  src/lib/workflow/model-config.ts:44:18           
OpenAIModelOption       interface  src/lib/workflow/model-config.ts:52:18           
InfraSnapshot           interface  src/lib/workflow/performance.ts:45:18            
KpiDef                  interface  src/lib/workflow/performance.ts:70:18            
KpiStat                 interface  src/lib/workflow/performance.ts:161:18           
AgentAgg                interface  src/lib/workflow/performance.ts:174:18           
RosterAgent             interface  src/lib/workflow/roster-loader.ts:12:18          
ShipFindingLike         interface  src/lib/workflow/ship-review.ts:18:18            
FixContract             interface  src/lib/workflow/types.ts:106:18                 
AgentPhase              type       src/lib/workflow/types.ts:134:13                 
WorkflowPhase           type       src/lib/workflow/types.ts:153:13                 
StoredEvent             interface  src/lib/workflow/types.ts:217:18                 
WorkflowType            type       src/lib/workflow/types.ts:222:13                 
RepoTarget              interface  src/lib/workflow/types.ts:281:18                 
MessageType             type       src/lib/workflow/types.ts:290:13                 
AgentMessage            interface  src/lib/workflow/types.ts:292:18                 
IntakeSourceType        type       src/lib/workflow/types.ts:304:13                 
PortedSession           interface  src/lib/workflow/types.ts:412:18                 
NotificationType        type       src/lib/workflow/types.ts:427:13                 
ReviewPackageLink       interface  src/lib/workflow/types.ts:436:18                 
WorkflowPhaseType       type       src/lib/workflow/workflow-defs.ts:20:13          
WorkflowDefPhase        interface  src/lib/workflow/workflow-defs.ts:22:18          
ArtifactChainEntry      interface  src/lib/workflow/workflow-defs.ts:92:18          
ArtifactChain           interface  src/lib/workflow/workflow-defs.ts:109:18         
FrameworkOverlay        interface  src/lib/workflow/workflow-defs.ts:126:18         
Duplicate exports (1)
WorkflowInputSchema|SubmitWorkflowInputSchema  mcp/hub/src/workflow/schemas.ts
Configuration hints (3)
[src/app/**/page.tsx, …]           knip.json  Remove, or move unused top-level entry to one of "workspaces"  
[src/**/*.{ts,tsx}, …]             knip.json  Remove, or move unused top-level project to one of "workspaces"
src/index.ts              mcp/hub  knip.json  Remove redundant entry pattern
```

### knip-mcp-hub.txt
```text
Unused exports (19)
DEFAULT_FILE_CAP_BYTES                mcp/hub/src/cloud-code/artifacts.ts:41:14 
DEFAULT_TOTAL_CAP_BYTES               mcp/hub/src/cloud-code/artifacts.ts:42:14 
DEFAULT_FILE_COUNT_CAP                mcp/hub/src/cloud-code/artifacts.ts:43:14 
safeRelPath                 function  mcp/hub/src/cloud-code/artifacts.ts:370:17
parseRepo                   function  mcp/hub/src/cloud-code/git.ts:53:17       
normalizeCloneUrl           function  mcp/hub/src/cloud-code/git.ts:65:17       
canPushToOrigin             function  mcp/hub/src/cloud-code/git.ts:106:23      
slugForPath                 function  mcp/hub/src/cloud-code/transcript.ts:18:17
projectDirFor               function  mcp/hub/src/cloud-code/transcript.ts:22:23
localTranscriptPath         function  mcp/hub/src/cloud-code/transcript.ts:52:23
RepoTargetSchema                      mcp/hub/src/workflow/schemas.ts:3:14      
RepoConfigSchema                      mcp/hub/src/workflow/schemas.ts:10:14     
IntakeSourceSchema                    mcp/hub/src/workflow/schemas.ts:31:14     
ModelOverrideSchema                   mcp/hub/src/workflow/schemas.ts:49:14     
PortedSessionSchema                   mcp/hub/src/workflow/schemas.ts:62:14     
IntentBriefSchema                     mcp/hub/src/workflow/schemas.ts:73:14     
WorkflowInputSchema                   mcp/hub/src/workflow/schemas.ts:82:14     
RoutineScheduleSchema                 mcp/hub/src/workflow/schemas.ts:132:14    
RoutineInputTemplateSchema            mcp/hub/src/workflow/schemas.ts:140:14    
Unused exported types (5)
ArtifactKind       type       mcp/hub/src/cloud-code/artifacts.ts:45:13 
ArtifactCandidate  interface  mcp/hub/src/cloud-code/artifacts.ts:47:18 
ServerCategory     type       mcp/hub/src/cloud-code/cli-config.ts:26:13
ServerTransport    type       mcp/hub/src/cloud-code/cli-config.ts:27:13
ClassifiedServer   interface  mcp/hub/src/cloud-code/cli-config.ts:36:18
Duplicate exports (1)
WorkflowInputSchema|SubmitWorkflowInputSchema  mcp/hub/src/workflow/schemas.ts
Configuration hints (1)
src/index.ts  mcp/hub  knip.json  Remove redundant entry pattern
```

### ts-prune-root.txt
```text
playwright.config.ts:40 - default
vitest.config.ts:14 - default
demo/playwright.config.ts:14 - default
src/middleware.ts:56 - middleware
src/middleware.ts:87 - config
demo/playwright/playwright.config.ts:3 - default
lambda/orchestrator/completion.mjs:92 - notTerminalPhaseGuard
lambda/orchestrator/completion.mjs:116 - notTerminalPhaseFilter
lambda/orchestrator/completion.mjs:147 - missingEvidenceTickets
lambda/orchestrator/completion.mjs:243 - resolveMissingEvidenceFromRecords
lambda/orchestrator/completion.mjs:297 - normalizeAdvisoryRoutingMode (used in module)
lambda/orchestrator/completion.mjs:323 - advisoryNeverApplies (used in module)
lambda/orchestrator/completion.mjs:338 - isAdvisoryTicket (used in module)
lambda/orchestrator/completion.mjs:345 - nonAdvisory (used in module)
lambda/orchestrator/completion.mjs:360 - isWorkflowComplete
lambda/orchestrator/completion.mjs:466 - shipVerdictOf (used in module)
lambda/orchestrator/completion.mjs:498 - evaluateShipVerdict
lambda/orchestrator/completion.mjs:35 - FIX_KINDS (used in module)
lambda/orchestrator/completion.mjs:45 - REWORK_FIX_KINDS
lambda/orchestrator/completion.mjs:56 - SHIP_BLOCKED_OUTCOMES (used in module)
lambda/orchestrator/completion.mjs:75 - TERMINAL_WORKFLOW_PHASES (used in module)
lambda/orchestrator/completion.mjs:131 - SHIP_PHASES
lambda/orchestrator/lease.mjs:83 - lastAgentActivity
lambda/orchestrator/lease.mjs:133 - lastStreamedText
lambda/orchestrator/lease.mjs:178 - hasAgentErrorSince
lambda/orchestrator/lease.mjs:214 - stealClaim
lambda/orchestrator/lease.mjs:42 - DEFAULT_TTL_MINUTES
lambda/orchestrator/lease.mjs:43 - STALE_CLAIM_MULTIPLIER
lambda/orchestrator/lease.mjs:51 - LEASE_TTL_MS (used in module)
lambda/orchestrator/review-cap.mjs:119 - fingerprintFinding (used in module)
lambda/orchestrator/review-cap.mjs:146 - roundContentFingerprint (used in module)
lambda/orchestrator/review-cap.mjs:164 - openEscalation (used in module)
lambda/orchestrator/review-cap.mjs:192 - parseDecision (used in module)
lambda/orchestrator/review-cap.mjs:300 - buildRoundRecord (used in module)
lambda/orchestrator/review-cap.mjs:396 - emitReviewCapMetrics (used in module)
lambda/orchestrator/review-cap.mjs:435 - emitReviewCapFailOpenMetrics (used in module)
lambda/orchestrator/review-cap.mjs:471 - createReviewCap
lambda/orchestrator/review-cap.mjs:469 - REVIEW_CAP_FAIL_OPEN_LIMIT (used in module)
src/app/layout.tsx:18 - default
src/app/layout.tsx:13 - metadata
src/app/page.tsx:58 - default
src/config/modules.ts:28 - ModuleId (used in module)
src/config/modules.ts:39 - NavItem (used in module)
src/lib/agentcore-sdk.ts:94 - getMemoryMapping (used in module)
src/lib/agentcore-sdk.ts:152 - DiscoveredAgent (used in module)
src/lib/agentcore-sdk.ts:169 - DiscoveredMemory (used in module)
src/lib/agentcore-sdk.ts:510 - PayloadFormat (used in module)
src/lib/agentcore-sdk.ts:910 - RegistryAuthorizerType (used in module)
src/lib/agentcore-sdk.ts:912 - Registry (used in module)
src/lib/agentcore-sdk.ts:925 - RegistryRecord (used in module)
src/lib/agentcore-sdk.ts:939 - RegistryRecordDetail (used in module)
src/lib/agentcore-sdk.ts:946 - CreateRegistryInput (used in module)
src/lib/agentcore-sdk.ts:955 - CreateRegistryRecordInput (used in module)
src/lib/agentcore-stream.ts:19 - StreamRequest (used in module)
src/lib/agentcore-stream.ts:43 - BuilderStreamRequest (used in module)
src/lib/cd-registry.ts:44 - DeliveryMode (used in module)
src/lib/cd-registry.ts:46 - CD_REGISTRY_KEY (used in module)
src/lib/client-cache.ts:75 - invalidateCache
src/lib/pipeline-config.ts:83 - TOOL_ICON_MAP (used in module)
src/lib/pipeline-config.ts:93 - PipelinePhaseId (used in module)
src/lib/pipeline-config.ts:99 - PipelineIdentityItem (used in module)
src/lib/pipeline-config.ts:104 - PipelineConfigItem (used in module)
src/lib/pipeline-config.ts:109 - PipelineDisplayItem (used in module)
src/lib/pipeline-config.ts:126 - PHASE_DISPLAY_META (used in module)
src/lib/pipeline-config.ts:244 - PipelineAgentConfig (used in module)
src/lib/pipeline-config.ts:447 - PIPELINE_PHASES
src/lib/utils.ts:8 - formatDuration
src/lib/utils.ts:15 - truncate
demo/playwright/v4/playwright-v4.config.ts:3 - default
deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx:7 - ThemeToggle
deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx:7 - ThemeToggle
evals/battery/lib/agent-runner.mjs:22 - PRICING_PER_MTOK (used in module)
evals/battery/lib/agent-runner.mjs:37 - MAX_TURNS (used in module)
evals/battery/lib/agent-runner.mjs:46 - MAX_TRANSPORT_RETRIES (used in module)
evals/battery/lib/agent-runner.mjs:85 - INFRA_RETRY_DELAY_MS (used in module)
evals/battery/lib/cases.mjs:87 - loadCaseValidator (used in module)
evals/battery/lib/cases.mjs:100 - loadBattery (used in module)
evals/battery/lib/cases.mjs:133 - duplicateCaseIds (used in module)
evals/battery/lib/cases.mjs:276 - defaultGitShow (used in module)
evals/battery/lib/cases.mjs:12 - PERSONA_EVALUATOR_ID (used in module)
evals/battery/lib/cases.mjs:13 - SCORING_BACKEND (used in module)
evals/battery/lib/cases.mjs:15 - batteryDir (used in module)
evals/battery/lib/mock-transport.mjs:25 - MOCK_DEFAULT (used in module)
evals/battery/lib/mock-transport.mjs:28 - SENSITIVE_EVALUATORS (used in module)
evals/battery/lib/redact.mjs:14 - GITHUB_OWNER_ALLOWLIST (used in module)
evals/battery/lib/scoring.mjs:83 - builtinInstruction
evals/battery/lib/scoring.mjs:98 - createConverseTransport
evals/battery/lib/scoring.mjs:15 - SCORING_BACKEND
evals/battery/lib/scoring.mjs:19 - JUDGE_MAX_TOKENS (used in module)
evals/battery/lib/scoring.mjs:21 - CUSTOM_EVALUATOR_ID (used in module)
evals/battery/lib/scoring.mjs:92 - HTTP_CONNECTION_TIMEOUT_MS (used in module)
evals/battery/lib/scoring.mjs:93 - HTTP_REQUEST_TIMEOUT_MS (used in module)
evals/battery/lib/scoring.mjs:94 - SDK_MAX_ATTEMPTS (used in module)
evals/battery/lib/thresholds.mjs:5 - SCALE (used in module)
src/app/agents/page.tsx:57 - default
src/app/build/page.tsx:17 - default
src/app/cloud-code/page.tsx:49 - default
src/app/connectors/page.tsx:22 - default
src/app/evaluations/page.tsx:113 - default
src/app/invoke/page.tsx:27 - default
src/app/pipeline/page.tsx:38 - default
src/app/registry/page.tsx:80 - default
src/app/routines/page.tsx:19 - default
src/app/tickets/page.tsx:118 - default
src/app/workflow/page.tsx:36 - default
src/components/cloud-code/CliBrand.tsx:9 - CLI_BRAND (used in module)
src/components/workflow/ArtifactViewer.tsx:20 - ArtifactKind (used in module)
src/components/workflow/PipelineVisualization.tsx:333 - default
src/components/workflow/useWorkflowStream.ts:6 - StreamStatus (used in module)
src/components/workflow/useWorkflowStream.ts:8 - UseWorkflowStreamOptions (used in module)
src/components/workflow/useWorkflowStream.ts:26 - UseWorkflowStreamReturn (used in module)
src/lib/auth/identity.ts:50 - authDisabled (used in module)
src/lib/auth/resolver.ts:14 - authMode (used in module)
src/lib/cloud-code/config-store.ts:47 - DEFAULT_SCOPE (used in module)
src/lib/cloud-code/config-store.ts:52 - UserConfig (used in module)
src/lib/cloud-code/github-store.ts:31 - GithubConnection (used in module)
src/lib/cloud-code/runtime.ts:36 - CodingTurnResult (used in module)
src/lib/cloud-code/runtime.ts:47 - CodingTurnParams (used in module)
src/lib/cloud-code/shell-protocol.ts:21 - DecodedFrame (used in module)
src/lib/cloud-code/use-voice-input.ts:49 - VoiceInput (used in module)
src/lib/connectors/secrets.ts:17 - secretIdFor (used in module)
src/lib/connectors/store.ts:23 - readRegistry (used in module)
src/lib/connectors/types.ts:33 - ConnectorStatus (used in module)
src/lib/metrics/gate-dwell.ts:15 - StatusTransition (used in module)
src/lib/metrics/throughput.ts:10 - WorkflowDuration (used in module)
src/lib/models/harness-models.ts:32 - BedrockApiFormat (used in module)
src/lib/models/harness-models.ts:33 - OpenAiApiFormat (used in module)
src/lib/models/harness-models.ts:36 - HarnessModelConfig (used in module)
src/lib/models/harness-models.ts:51 - ModelProvider (used in module)
src/lib/models/harness-models.ts:53 - HarnessModelOption (used in module)
src/lib/pipeline/status.ts:23 - CiBuildSummary (used in module)
src/lib/pipeline/status.ts:32 - StageState (used in module)
src/lib/pipeline/status.ts:44 - PipelineStatus (used in module)
src/lib/routines/schedule.ts:40 - scheduleNameFor (used in module)
src/lib/routines/store.ts:37 - getRoutine (used in module)
src/lib/routines/store.ts:23 - DEFAULT_USER_ID
src/lib/routines/store.ts:23 - DEFAULT_TENANT_ID (used in module)
src/lib/routines/types.ts:19 - RoutineRepoConfig (used in module)
src/lib/routines/types.ts:48 - RoutineLastRun (used in module)
src/lib/workflow/analysis-types.ts:13 - AnalysisTrigger (used in module)
src/lib/workflow/analysis-types.ts:19 - FindingKind (used in module)
src/lib/workflow/analysis-types.ts:20 - FindingSeverity (used in module)
src/lib/workflow/analysis-types.ts:21 - RecommendationPriority (used in module)
src/lib/workflow/analysis-types.ts:22 - RecommendationType (used in module)
src/lib/workflow/analysis-types.ts:29 - PhaseMetric (used in module)
src/lib/workflow/analysis-types.ts:37 - AgentTaskMetric (used in module)
src/lib/workflow/analysis-types.ts:48 - HumanReviewMetric (used in module)
src/lib/workflow/analysis-types.ts:67 - FixTicketEntry (used in module)
src/lib/workflow/analysis-types.ts:84 - ChangeRequestCycle (used in module)
src/lib/workflow/analysis-types.ts:91 - ManagerIntervention (used in module)
src/lib/workflow/analysis-types.ts:98 - WorkflowMetrics (used in module)
src/lib/workflow/analysis-types.ts:139 - AnalysisScores (used in module)
src/lib/workflow/analysis-types.ts:165 - AnalysisTrend (used in module)
src/lib/workflow/command-queue.ts:23 - WorkflowCommand
src/lib/workflow/completion-evidence.ts:21 - CompletionRecord (used in module)
src/lib/workflow/completion-evidence.ts:32 - EvidenceEntryLike (used in module)
src/lib/workflow/completion-evidence.ts:41 - MissingEvidenceTicket (used in module)
src/lib/workflow/completion-evidence.ts:46 - BackfillFields (used in module)
src/lib/workflow/completion-evidence.ts:53 - ResolveEvidenceDeps (used in module)
src/lib/workflow/intake.ts:19 - redactUrl (used in module)
src/lib/workflow/intake.ts:75 - SourceOutcome (used in module)
src/lib/workflow/intake.ts:97 - SourceValidationMode (used in module)
src/lib/workflow/intake.ts:104 - LookupImpl (used in module)
src/lib/workflow/intake.ts:108 - ValidateIntakeSourcesOptions (used in module)
src/lib/workflow/jira-client.ts:11 - JIRA_STATUS_TO_INTERNAL (used in module)
src/lib/workflow/jira-client.ts:25 - INTERNAL_STATUS_TO_JIRA (used in module)
src/lib/workflow/jira-client.ts:60 - JiraClientConfig (used in module)
src/lib/workflow/jira-client.ts:66 - JiraIssue (used in module)
src/lib/workflow/jira-client.ts:91 - JiraTransition (used in module)
src/lib/workflow/jira-client.ts:97 - JiraSearchResult (used in module)
src/lib/workflow/lease.ts:42 - AgentTaskEntry (used in module)
src/lib/workflow/model-config.ts:18 - ModelProvider (used in module)
src/lib/workflow/model-config.ts:26 - ModelOptionBase (used in module)
src/lib/workflow/model-config.ts:44 - BedrockModelOption (used in module)
src/lib/workflow/model-config.ts:52 - OpenAIModelOption (used in module)
src/lib/workflow/performance.ts:113 - quantile (used in module)
src/lib/workflow/performance.ts:154 - getPath (used in module)
src/lib/workflow/performance.ts:217 - isValidCard (used in module)
src/lib/workflow/performance.ts:45 - InfraSnapshot (used in module)
src/lib/workflow/performance.ts:70 - KpiDef (used in module)
src/lib/workflow/performance.ts:83 - FLEET_KPIS (used in module)
src/lib/workflow/performance.ts:101 - BASELINE_DAYS (used in module)
src/lib/workflow/performance.ts:102 - BASELINE_MIN (used in module)
src/lib/workflow/performance.ts:125 - Band (used in module)
src/lib/workflow/performance.ts:161 - KpiStat (used in module)
src/lib/workflow/performance.ts:174 - AgentAgg (used in module)
src/lib/workflow/repo-check.ts:21 - RepoCheckResult (used in module)
src/lib/workflow/repo-check.ts:38 - RepoCheckOptions (used in module)
src/lib/workflow/roster-loader.ts:22 - loadRoster (used in module)
src/lib/workflow/roster-loader.ts:12 - RosterAgent (used in module)
src/lib/workflow/sdlc-framework.ts:9 - SdlcFramework (used in module)
src/lib/workflow/ship-review.ts:18 - ShipFindingLike (used in module)
src/lib/workflow/ship-review.ts:52 - EffectiveRoundCountOpts (used in module)
src/lib/workflow/source-shape.ts:29 - INTAKE_SOURCE_TYPES (used in module)
src/lib/workflow/source-shape.ts:105 - SourceDisplay (used in module)
src/lib/workflow/transform-event.ts:11 - TransformOptions (used in module)
src/lib/workflow/types.ts:106 - FixContract (used in module)
src/lib/workflow/types.ts:134 - AgentPhase
src/lib/workflow/types.ts:217 - StoredEvent (used in module)
src/lib/workflow/types.ts:222 - WorkflowType (used in module)
src/lib/workflow/types.ts:281 - RepoTarget (used in module)
src/lib/workflow/types.ts:290 - MessageType (used in module)
src/lib/workflow/types.ts:292 - AgentMessage (used in module)
src/lib/workflow/types.ts:304 - IntakeSourceType (used in module)
src/lib/workflow/types.ts:412 - PortedSession (used in module)
src/lib/workflow/types.ts:427 - NotificationType (used in module)
src/lib/workflow/types.ts:436 - ReviewPackageLink (used in module)
src/lib/workflow/watchdog.ts:27 - WatchdogConfig (used in module)
src/lib/workflow/watchdog.ts:34 - PartialWatchdog (used in module)
src/lib/workflow/workflow-defs.ts:280 - sdlcFrameworkForDef (used in module)
src/lib/workflow/workflow-defs.ts:285 - isHumanAssignee
src/lib/workflow/workflow-defs.ts:20 - WorkflowPhaseType (used in module)
src/lib/workflow/workflow-defs.ts:22 - WorkflowDefPhase (used in module)
src/lib/workflow/workflow-defs.ts:92 - ArtifactChainEntry (used in module)
src/lib/workflow/workflow-defs.ts:109 - ArtifactChain (used in module)
src/lib/workflow/workflow-defs.ts:116 - SdlcFramework (used in module)
src/lib/workflow/workflow-defs.ts:126 - FrameworkOverlay (used in module)
src/lib/workflow/workspace.ts:36 - writeArtifact
evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:10 - parseSession
evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:26 - getTenantScope
evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:4 - Session (used in module)
evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts:10 - paginate
evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts:3 - Page (used in module)
evals/battery/fixtures/fix-race-condition-cas-003/store.ts:5 - ConversationRecord (used in module)
evals/battery/fixtures/fix-race-condition-cas-003/store.ts:19 - ConversationStore
src/app/agents/[id]/page.tsx:60 - default
src/app/api/connectors/route.ts:27 - GET
src/app/api/connectors/route.ts:37 - POST
src/app/api/connectors/route.ts:25 - dynamic
src/app/api/evaluations/route.ts:42 - GET
src/app/api/evaluations/route.ts:14 - dynamic
src/app/api/evaluations/route.ts:15 - revalidate
src/app/api/evaluations/route.ts:16 - fetchCache
src/app/api/health/route.ts:3 - GET
src/app/api/models/route.ts:40 - GET
src/app/api/routines/route.ts:22 - GET
src/app/api/routines/route.ts:36 - POST
src/app/api/routines/route.ts:20 - dynamic
src/app/evaluations/config/page.tsx:85 - default
src/app/api/agentcore/agents/route.ts:11 - GET
src/app/api/agentcore/builder/route.ts:13 - POST
src/app/api/agentcore/deploy/route.ts:12 - POST
src/app/api/agentcore/invoke/route.ts:9 - POST
src/app/api/agentcore/metrics/route.ts:94 - GET
src/app/api/agentcore/metrics/route.ts:3 - dynamic
src/app/api/agentcore/payload-format/route.ts:8 - GET
src/app/api/agentcore/payload-format/route.ts:21 - POST
src/app/api/agentcore/region/route.ts:19 - GET
src/app/api/agentcore/region/route.ts:31 - POST
src/app/api/agentcore/registry/route.ts:10 - GET
src/app/api/agentcore/registry/route.ts:26 - POST
src/app/api/agentcore/registry/route.ts:4 - dynamic
src/app/api/agentcore/traces/route.ts:71 - GET
src/app/api/agentcore/traces/route.ts:126 - POST
src/app/api/cloud-code/config/route.ts:37 - GET
src/app/api/cloud-code/config/route.ts:43 - POST
src/app/api/cloud-code/config/route.ts:106 - PUT
src/app/api/cloud-code/config/route.ts:30 - dynamic
src/app/api/cloud-code/config/route.ts:31 - maxDuration
src/app/api/cloud-code/github/route.ts:16 - GET
src/app/api/cloud-code/github/route.ts:43 - DELETE
src/app/api/cloud-code/github/route.ts:14 - dynamic
src/app/api/cloud-code/sessions/route.ts:14 - GET
src/app/api/cloud-code/sessions/route.ts:35 - POST
src/app/api/cloud-code/sessions/route.ts:12 - dynamic
src/app/api/connectors/[id]/route.ts:16 - GET
src/app/api/connectors/[id]/route.ts:23 - PATCH
src/app/api/connectors/[id]/route.ts:64 - DELETE
src/app/api/connectors/[id]/route.ts:14 - dynamic
src/app/api/evaluations/agents/route.ts:6 - GET
src/app/api/evaluations/agents/route.ts:4 - dynamic
src/app/api/evaluations/loop/route.ts:55 - GET
src/app/api/evaluations/loop/route.ts:75 - POST
src/app/api/evaluations/loop/route.ts:15 - dynamic
src/app/api/jira/metrics/route.ts:546 - GET
src/app/api/jira/metrics/route.ts:6 - dynamic
src/app/api/pipeline/status/route.ts:9 - GET
src/app/api/pipeline/status/route.ts:7 - dynamic
src/app/api/routines/[id]/route.ts:20 - GET
src/app/api/routines/[id]/route.ts:31 - PATCH
src/app/api/routines/[id]/route.ts:86 - DELETE
src/app/api/routines/[id]/route.ts:18 - dynamic
src/app/api/routines/chat/route.ts:38 - POST
src/app/api/routines/chat/route.ts:21 - runtime
src/app/api/routines/chat/route.ts:22 - dynamic
src/app/api/routines/definitions/route.ts:29 - GET
src/app/api/routines/definitions/route.ts:13 - dynamic
src/app/api/workflow/[id]/route.ts:33 - DELETE
src/app/api/workflow/[id]/route.ts:31 - dynamic
src/app/api/workflow/artifacts/route.ts:4 - GET
src/app/api/workflow/cd-registry/route.ts:27 - GET
src/app/api/workflow/cd-registry/route.ts:41 - POST
src/app/api/workflow/cd-registry/route.ts:62 - DELETE
src/app/api/workflow/cd-registry/route.ts:25 - dynamic
src/app/api/workflow/definitions/route.ts:15 - GET
src/app/api/workflow/definitions/route.ts:13 - dynamic
src/app/api/workflow/list/route.ts:6 - GET
src/app/api/workflow/list/route.ts:4 - dynamic
src/app/api/workflow/performance/route.ts:47 - GET
src/app/api/workflow/performance/route.ts:19 - dynamic
src/app/api/workflow/state/route.ts:9 - GET
src/app/api/workflow/webhook/route.ts:21 - POST
src/app/api/workflow-manager/chat/route.ts:97 - POST
src/app/api/workflow-manager/chat/route.ts:24 - runtime
src/app/api/workflow-manager/chat/route.ts:25 - dynamic
src/app/api/agentcore/memory/events/route.ts:26 - GET
src/app/api/agentcore/memory/events/route.ts:114 - POST
src/app/api/agentcore/memory/mapping/route.ts:14 - GET
src/app/api/agentcore/memory/mapping/route.ts:28 - POST
src/app/api/agentcore/memory/sessions/route.ts:24 - GET
src/app/api/agentcore/registry/[registryId]/route.ts:12 - GET
src/app/api/agentcore/registry/[registryId]/route.ts:28 - PATCH
src/app/api/agentcore/registry/[registryId]/route.ts:44 - DELETE
src/app/api/agentcore/registry/[registryId]/route.ts:4 - dynamic
src/app/api/agentcore/traces/health/route.ts:51 - GET
src/app/api/agentcore/traces/health/route.ts:17 - TraceHealthIssue (used in module)
src/app/api/agentcore/traces/health/route.ts:30 - TraceHealth (used in module)
src/app/api/agentcore/traces/sessions/route.ts:27 - GET
src/app/api/cloud-code/github/callback/route.ts:30 - GET
src/app/api/cloud-code/github/callback/route.ts:24 - dynamic
src/app/api/cloud-code/github/install/route.ts:21 - GET
src/app/api/cloud-code/github/install/route.ts:15 - dynamic
src/app/api/cloud-code/github/manifest/route.ts:30 - GET
src/app/api/cloud-code/github/manifest/route.ts:24 - dynamic
src/app/api/cloud-code/sessions/[id]/route.ts:61 - PATCH
src/app/api/cloud-code/sessions/[id]/route.ts:87 - GET
src/app/api/cloud-code/sessions/[id]/route.ts:104 - DELETE
src/app/api/cloud-code/sessions/[id]/route.ts:19 - dynamic
src/app/api/cloud-code/sessions/port/route.ts:137 - POST
src/app/api/cloud-code/sessions/port/route.ts:48 - dynamic
src/app/api/connectors/[id]/credentials/route.ts:17 - POST
src/app/api/connectors/[id]/credentials/route.ts:15 - dynamic
src/app/api/evaluations/agents/[agentId]/route.ts:45 - PUT
src/app/api/evaluations/agents/[agentId]/route.ts:4 - dynamic
src/app/api/routines/[id]/run/route.ts:17 - POST
src/app/api/routines/[id]/run/route.ts:15 - dynamic
src/app/api/workflow/[id]/agent-output/route.ts:73 - GET
src/app/api/workflow/[id]/agent-output/route.ts:32 - dynamic
src/app/api/workflow/[id]/analyze/route.ts:27 - POST
src/app/api/workflow/[id]/analyze/route.ts:25 - dynamic
src/app/api/workflow/[id]/archive/route.ts:21 - PATCH
src/app/api/workflow/[id]/archive/route.ts:19 - dynamic
src/app/api/workflow/[id]/escalations/route.ts:32 - GET
src/app/api/workflow/[id]/escalations/route.ts:45 - PATCH
src/app/api/workflow/[id]/escalations/route.ts:23 - dynamic
src/app/api/workflow/[id]/events/route.ts:22 - GET
src/app/api/workflow/[id]/events/route.ts:13 - dynamic
src/app/api/workflow/[id]/message/route.ts:30 - POST
src/app/api/workflow/[id]/message/route.ts:19 - dynamic
src/app/api/workflow/[id]/nudge/route.ts:267 - POST
src/app/api/workflow/[id]/nudge/route.ts:32 - dynamic
src/app/api/workflow/[id]/retry/route.ts:151 - POST
src/app/api/workflow/[id]/retry/route.ts:73 - dynamic
src/app/api/workflow/[id]/state/route.ts:35 - GET
src/app/api/workflow/[id]/state/route.ts:4 - dynamic
src/app/api/workflow/[id]/stream/route.ts:29 - GET
src/app/api/workflow/[id]/stream/route.ts:17 - runtime
src/app/api/workflow/[id]/stream/route.ts:18 - dynamic
src/app/api/workflow/[id]/tickets/route.ts:9 - GET
src/app/api/workflow/[id]/tickets/route.ts:5 - dynamic
src/app/api/workflow/[id]/watch/route.ts:23 - GET
src/app/api/workflow/[id]/watch/route.ts:33 - PATCH
src/app/api/workflow/[id]/watch/route.ts:21 - dynamic
src/app/api/workflow/artifacts/content/route.ts:51 - GET
src/app/api/workflow/artifacts/content/route.ts:93 - PUT
src/app/api/workflow/artifacts/download/route.ts:11 - GET
src/app/api/agentcore/registry/[registryId]/records/route.ts:18 - GET
src/app/api/agentcore/registry/[registryId]/records/route.ts:43 - POST
src/app/api/agentcore/registry/[registryId]/records/route.ts:10 - dynamic
src/app/api/agentcore/registry/[registryId]/search/route.ts:17 - POST
src/app/api/agentcore/registry/[registryId]/search/route.ts:8 - dynamic
src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:61 - GET
src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:121 - POST
src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:24 - dynamic
src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:30 - POST
src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:23 - dynamic
src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:24 - maxDuration
src/app/api/cloud-code/sessions/[id]/message/route.ts:55 - POST
src/app/api/cloud-code/sessions/[id]/message/route.ts:20 - dynamic
src/app/api/cloud-code/sessions/[id]/message/route.ts:22 - maxDuration
src/app/api/cloud-code/sessions/[id]/shell/route.ts:32 - POST
src/app/api/cloud-code/sessions/[id]/shell/route.ts:22 - dynamic
src/app/api/cloud-code/sessions/[id]/shell/route.ts:26 - maxDuration
src/app/api/cloud-code/sessions/[id]/stop/route.ts:42 - POST
src/app/api/cloud-code/sessions/[id]/stop/route.ts:35 - dynamic
src/app/api/cloud-code/sessions/[id]/stop/route.ts:36 - maxDuration
src/app/api/cloud-code/sessions/[id]/warm/route.ts:21 - POST
src/app/api/cloud-code/sessions/[id]/warm/route.ts:18 - dynamic
src/app/api/cloud-code/sessions/[id]/warm/route.ts:19 - maxDuration
src/app/api/evaluations/agents/[agentId]/flush/route.ts:17 - POST
src/app/api/evaluations/agents/[agentId]/flush/route.ts:15 - dynamic
src/app/api/workflow/[id]/tickets/comment/route.ts:29 - POST
src/app/api/workflow/[id]/tickets/comment/route.ts:27 - dynamic
src/app/api/workflow/[id]/tickets/transition/route.ts:24 - POST
src/app/api/workflow/[id]/tickets/transition/route.ts:7 - dynamic
src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:17 - GET
src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:34 - PATCH
src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:67 - DELETE
src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:9 - dynamic
src/app/api/agentcore/registry/[registryId]/records/[recordId]/approval/route.ts:24 - POST
src/app/api/agentcore/registry/[registryId]/records/[recordId]/approval/route.ts:9 - dynamic
```

### ts-prune-mcp-hub.txt
```text
mcp/hub/src/auth.ts:109 - ClientResult (used in module)
mcp/hub/src/cloud-code/artifacts.ts:370 - safeRelPath (used in module)
mcp/hub/src/cloud-code/artifacts.ts:41 - DEFAULT_FILE_CAP_BYTES (used in module)
mcp/hub/src/cloud-code/artifacts.ts:42 - DEFAULT_TOTAL_CAP_BYTES (used in module)
mcp/hub/src/cloud-code/artifacts.ts:43 - DEFAULT_FILE_COUNT_CAP (used in module)
mcp/hub/src/cloud-code/artifacts.ts:45 - ArtifactKind (used in module)
mcp/hub/src/cloud-code/artifacts.ts:47 - ArtifactCandidate (used in module)
mcp/hub/src/cloud-code/artifacts.ts:56 - DetectResult (used in module)
mcp/hub/src/cloud-code/artifacts.ts:181 - DetectOptions (used in module)
mcp/hub/src/cloud-code/cli-config.ts:26 - ServerCategory (used in module)
mcp/hub/src/cloud-code/cli-config.ts:27 - ServerTransport (used in module)
mcp/hub/src/cloud-code/cli-config.ts:36 - ClassifiedServer (used in module)
mcp/hub/src/cloud-code/cli-config.ts:44 - GatherResult (used in module)
mcp/hub/src/cloud-code/git.ts:53 - parseRepo (used in module)
mcp/hub/src/cloud-code/git.ts:65 - normalizeCloneUrl (used in module)
mcp/hub/src/cloud-code/git.ts:106 - canPushToOrigin (used in module)
mcp/hub/src/cloud-code/git.ts:44 - GitState (used in module)
mcp/hub/src/cloud-code/git.ts:113 - GitHandoff (used in module)
mcp/hub/src/cloud-code/transcript.ts:18 - slugForPath (used in module)
mcp/hub/src/cloud-code/transcript.ts:22 - projectDirFor (used in module)
mcp/hub/src/cloud-code/transcript.ts:52 - localTranscriptPath (used in module)
mcp/hub/src/workflow/schemas.ts:3 - RepoTargetSchema (used in module)
mcp/hub/src/workflow/schemas.ts:10 - RepoConfigSchema (used in module)
mcp/hub/src/workflow/schemas.ts:31 - IntakeSourceSchema (used in module)
mcp/hub/src/workflow/schemas.ts:49 - ModelOverrideSchema (used in module)
mcp/hub/src/workflow/schemas.ts:62 - PortedSessionSchema (used in module)
mcp/hub/src/workflow/schemas.ts:73 - IntentBriefSchema (used in module)
mcp/hub/src/workflow/schemas.ts:82 - WorkflowInputSchema (used in module)
mcp/hub/src/workflow/schemas.ts:132 - RoutineScheduleSchema (used in module)
mcp/hub/src/workflow/schemas.ts:140 - RoutineInputTemplateSchema (used in module)
```

### depcheck-root.txt
```text
Unused dependencies
* @aws-sdk/client-bedrock-agent-runtime
Unused devDependencies
* autoprefixer
* depcheck
* knip
* postcss
* ts-prune
Missing dependencies
* ajv: ./evals/battery/lint-fixtures.mjs
```

### depcheck-mcp-hub.txt
```text
No depcheck issue
```

## 6. Complete ledger

| # | Tool(s) | Rule | Location | Symbol | Verdict | Evidence |
|---:|---|---|---|---|---|---|
| 1 | knip-root | Unused files | demo/playwright.config.ts | demo/playwright.config.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 2 | knip-root | Unused files | demo/playwright/playwright.config.ts | demo/playwright/playwright.config.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 3 | knip-root | Unused files | demo/playwright/test-popup.spec.ts | demo/playwright/test-popup.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 4 | knip-root | Unused files | demo/playwright/test-s3-modal.spec.ts | demo/playwright/test-s3-modal.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 5 | knip-root | Unused files | demo/playwright/v4/check-layout.spec.ts | demo/playwright/v4/check-layout.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 6 | knip-root | Unused files | demo/playwright/v4/playwright-v4.config.ts | demo/playwright/v4/playwright-v4.config.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 7 | knip-root | Unused files | demo/playwright/v4/record-demo-v4.spec.ts | demo/playwright/v4/record-demo-v4.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 8 | knip-root | Unused files | demo/playwright/v4/test-agent-streaming.spec.ts | demo/playwright/v4/test-agent-streaming.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 9 | knip-root | Unused files | demo/playwright/v4/test-lambda-orchestration.spec.ts | demo/playwright/v4/test-lambda-orchestration.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 10 | knip-root | Unused files | demo/record.spec.ts | demo/record.spec.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=3 |
| 11 | knip-root | Unused files | deploy/pipeline/bin/pipeline.ts | deploy/pipeline/bin/pipeline.ts | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 12 | knip-root | Unused files | deploy/pipeline/harness-snapshot.mjs | deploy/pipeline/harness-snapshot.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 13 | knip-root | Unused files | deploy/pipeline/lib/pipeline-stack.ts | deploy/pipeline/lib/pipeline-stack.ts | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 14 | knip-root | Unused files | deploy/pipeline/restore-harness.mjs | deploy/pipeline/restore-harness.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 15 | knip-root | Unused files | deploy/routine-builder/setup-routine-builder.mjs | deploy/routine-builder/setup-routine-builder.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 16 | knip-root | Unused files | deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx | deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 17 | knip-root | Unused files | deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx | deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 18 | knip-root | Unused files | deploy/setup-builder-agent.mjs | deploy/setup-builder-agent.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 19 | knip-root | Unused files | deploy/setup-tickets-lambda.mjs | deploy/setup-tickets-lambda.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 20 | knip-root | Unused files | deploy/workflow-manager/setup-workflow-manager.mjs | deploy/workflow-manager/setup-workflow-manager.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 21 | knip-root | Unused files | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=5 |
| 22 | knip-root | Unused files | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=3 |
| 23 | knip-root | Unused files | evals/battery/fixtures/fix-race-condition-cas-003/store.ts | evals/battery/fixtures/fix-race-condition-cas-003/store.ts | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=4 |
| 24 | knip-root | Unused files | lambda/agentcore-hub-jira/index.test.mjs | lambda/agentcore-hub-jira/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 25 | knip-root | Unused files | lambda/anomaly-watcher/detect.test.mjs | lambda/anomaly-watcher/detect.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 26 | knip-root | Unused files | lambda/anomaly-watcher/index.test.mjs | lambda/anomaly-watcher/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 27 | knip-root | Unused files | lambda/builder-tools/index.mjs | lambda/builder-tools/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 28 | knip-root | Unused files | lambda/cost-report/index.test.mjs | lambda/cost-report/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 29 | knip-root | Unused files | lambda/cost-report/pricing.test.mjs | lambda/cost-report/pricing.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 30 | knip-root | Unused files | lambda/orchestrator/model-router.mjs | lambda/orchestrator/model-router.mjs | KEEP-H11/H14 | documented test-only (check-lambda-zip-manifest.sh:13-14); deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 31 | knip-root | Unused files | lambda/orchestrator/model-router.test.mjs | lambda/orchestrator/model-router.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 32 | knip-root | Unused files | lambda/prd-submitter/index.mjs | lambda/prd-submitter/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 33 | knip-root | Unused files | lambda/routines-runner/index.mjs | lambda/routines-runner/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 34 | knip-root | Unused files | lambda/routines-runner/index.test.mjs | lambda/routines-runner/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 35 | knip-root | Unused files | lambda/token-aggregator/index.mjs | lambda/token-aggregator/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 36 | knip-root | Unused files | lambda/workflow-analyzer/index.mjs | lambda/workflow-analyzer/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 37 | knip-root | Unused files | scripts/backfill-workflow-tombstones.mjs | scripts/backfill-workflow-tombstones.mjs | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 38 | knip-root | Unused files | scripts/migrate-default-identity.mjs | scripts/migrate-default-identity.mjs | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 39 | knip-root | Unused files | src/components/workflow/PipelineVisualization.tsx | src/components/workflow/PipelineVisualization.tsx | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 40 | knip-root | Unused files | src/lib/models/harness-models.ts | src/lib/models/harness-models.ts | KEEP-ambiguous | 0 non-definition hits; not removed this sweep — default KEEP — conservative; candidate for the next sweep |
| 41 | knip-root | Unused devDependencies | package.json:69:6 | depcheck | KEEP-H5 | sweep tooling, invoked via npx |
| 42 | knip-root | Unused devDependencies | package.json:75:6 | ts-prune | KEEP-H5 | sweep tooling, invoked via npx |
| 43 | knip-root | Unlisted dependencies | evals/battery/lib/cases.mjs:91:29 | ajv/dist/2020 | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 44 | knip-root | Unlisted dependencies | evals/battery/lint-fixtures.mjs:53:27 | ajv/dist/2020 | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 45 | knip-root | Unlisted dependencies | lambda/anomaly-watcher/index.mjs:627:31 | js-yaml | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 46 | knip-root | Unlisted dependencies | lambda/orchestrator/agent-invoker.mjs:150:11 | @smithy/node-http-handler | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 47 | knip-root | Unlisted binaries | deploy/lib/__tests__/check-eval-gate.test.ts | script | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 48 | knip-root | Unlisted binaries | deploy/lib/__tests__/check-eval-gate.test.ts | setsid | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 49 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/agent-runner.mjs:22:14 | PRICING_PER_MTOK | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 50 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/agent-runner.mjs:37:14 | MAX_TURNS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 51 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/agent-runner.mjs:85:14 | INFRA_RETRY_DELAY_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 52 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:12:14 | PERSONA_EVALUATOR_ID | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 53 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:15:14 | batteryDir | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 54 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:87:17 | loadCaseValidator | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 55 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:100:17 | loadBattery | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 56 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:276:17 | defaultGitShow | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 57 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/mock-transport.mjs:25:14 | MOCK_DEFAULT | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 58 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/mock-transport.mjs:28:14 | SENSITIVE_EVALUATORS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 59 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/redact.mjs:14:14 | GITHUB_OWNER_ALLOWLIST | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 60 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:19:14 | JUDGE_MAX_TOKENS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 61 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:21:14 | CUSTOM_EVALUATOR_ID | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 62 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:83:17 | builtinInstruction | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=8 |
| 63 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:92:14 | HTTP_CONNECTION_TIMEOUT_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 64 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:93:14 | HTTP_REQUEST_TIMEOUT_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 65 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:94:14 | SDK_MAX_ATTEMPTS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 66 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/thresholds.mjs:5:14 | SCALE | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 67 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:72:14 | REWORK_FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 68 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:86:14 | SPAWN_ORIGIN_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 69 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:94:14 | SPAWN_EXTRA_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 70 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:100:14 | EVIDENCE_SOURCES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 71 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:102:14 | CONTRACT_VERSION | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 72 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:109:14 | SYSTEM_LABEL_PREFIXES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 73 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:138:14 | RESERVED_ADVISORY_LABEL | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 74 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:395:17 | parseFixContractBlock | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 75 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:506:17 | advisoryIsReserved | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 76 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:66:14 | FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 77 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:72:14 | REWORK_FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 78 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:76:14 | KIND_TO_ORIGIN_KEY | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 79 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:86:14 | SPAWN_ORIGIN_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 80 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:94:14 | SPAWN_EXTRA_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 81 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:100:14 | EVIDENCE_SOURCES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 82 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:102:14 | CONTRACT_VERSION | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 83 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:109:14 | SYSTEM_LABEL_PREFIXES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 84 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:138:14 | RESERVED_ADVISORY_LABEL | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 85 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:140:14 | TICKET_KEY_RE | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 86 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:347:17 | renderFixContractBlock | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 87 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:395:17 | parseFixContractBlock | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 88 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:482:17 | contractLabels | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 89 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:506:17 | advisoryIsReserved | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 90 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:574:17 | escapeJql | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 91 | knip-root | Unused exports | lambda/anomaly-watcher/bands-schema.mjs:28:14 | VERIFIED_EVENT_TYPES | KEEP-H11/H14 | surfaces.json entry bands-schema.mjs; surfaces.json basename hits=1 |
| 92 | knip-root | Unused exports | lambda/anomaly-watcher/detect.mjs:30:14 | MAX_OPEN_PAIRS | KEEP-H11/H14 | surfaces.json entry detect.mjs; surfaces.json basename hits=1 |
| 93 | knip-root | Unused exports | lambda/anomaly-watcher/detect.mjs:32:14 | MAX_CONTRIBUTORS | KEEP-H11/H14 | surfaces.json entry detect.mjs; surfaces.json basename hits=1 |
| 94 | knip-root | Unused exports | lambda/anomaly-watcher/detect.mjs:75:17 | hourBucket | KEEP-H11/H14 | surfaces.json entry detect.mjs; surfaces.json basename hits=1 |
| 95 | knip-root | Unused exports | lambda/orchestrator/artifact-chain.mjs:19:14 | ARTIFACT_CHAIN_GATE_MODES | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 96 | knip-root | Unused exports | lambda/orchestrator/artifact-chain.mjs:72:14 | CODE_REVIEWER_AGENT | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 97 | knip-root | Unused exports | lambda/orchestrator/artifact-chain.mjs:73:14 | PLAN_TICKET_TITLE | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 98 | knip-root | Unused exports | lambda/orchestrator/cascade.mjs:685:17 | hasCascadeActivity | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 99 | knip-root | Unused exports | lambda/orchestrator/cascade.mjs:700:17 | emitCascadeMetrics | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 100 | knip-root | Unused exports | lambda/orchestrator/dead-session-detector.mjs:560:17 | emitMetrics | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 101 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:66:14 | FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 102 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:72:14 | REWORK_FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 103 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:86:14 | SPAWN_ORIGIN_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 104 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:94:14 | SPAWN_EXTRA_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 105 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:100:14 | EVIDENCE_SOURCES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 106 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:102:14 | CONTRACT_VERSION | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 107 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:109:14 | SYSTEM_LABEL_PREFIXES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 108 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:138:14 | RESERVED_ADVISORY_LABEL | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 109 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:173:17 | normalizeContractMode | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 110 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:482:17 | contractLabels | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 111 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:506:17 | advisoryIsReserved | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 112 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:526:17 | sanitizeUserLabels | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 113 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:574:17 | escapeJql | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 114 | knip-root | Unused exports | lambda/orchestrator/reconcile-sweep.mjs:255:17 | emitReconcileMetrics | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 115 | knip-root | Unused exports | lambda/orchestrator/repo-check.mjs:100:23 | checkRepoConfig | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=2 |
| 116 | knip-root, ts-prune-root | Unused exports, Unused export | lambda/orchestrator/review-cap.mjs:396:17 | emitReviewCapMetrics | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 117 | knip-root, ts-prune-root | Unused exports, Unused export | lambda/orchestrator/review-cap.mjs:435:17 | emitReviewCapFailOpenMetrics | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 118 | knip-root | Unused exports | lambda/orchestrator/sync-main.mjs:102:14 | MAX_SYNC_FIX_ROUNDS | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 119 | knip-root | Unused exports | lambda/orchestrator/watchdog.mjs:45:17 | _getWatchdogSource | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 120 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:41:14 | DEFAULT_FILE_CAP_BYTES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 121 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:42:14 | DEFAULT_TOTAL_CAP_BYTES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 122 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:43:14 | DEFAULT_FILE_COUNT_CAP | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 123 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:370:17 | safeRelPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 124 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/git.ts:53:17 | parseRepo | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 125 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/git.ts:65:17 | normalizeCloneUrl | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 126 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/git.ts:106:23 | canPushToOrigin | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 127 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/transcript.ts:18:17 | slugForPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 128 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/transcript.ts:22:23 | projectDirFor | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 129 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/transcript.ts:52:23 | localTranscriptPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 130 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:3:14 | RepoTargetSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 131 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:10:14 | RepoConfigSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 132 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:31:14 | IntakeSourceSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 133 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:49:14 | ModelOverrideSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 134 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:62:14 | PortedSessionSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 135 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:73:14 | IntentBriefSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 136 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:82:14 | WorkflowInputSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 137 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:132:14 | RoutineScheduleSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 138 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:140:14 | RoutineInputTemplateSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 139 | knip-root, ts-prune-root | Unused exports, Unused export | src/components/cloud-code/CliBrand.tsx:9:14 | CLI_BRAND | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 140 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/agentcore-sdk.ts:94:17 | getMemoryMapping | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 141 | knip-root | Unused exports | src/lib/agentcore-sdk.ts:141:17 | getLogsClient | KEEP-referenced | 12 non-definition hits; first: src/app/api/agentcore/metrics/route.ts:22 |
| 142 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/auth/identity.ts:50:17 | authDisabled | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 143 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/auth/resolver.ts:14:17 | authMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 144 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/cd-registry.ts:46:14 | CD_REGISTRY_KEY | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 145 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/client-cache.ts:75:17 | invalidateCache | REMOVED | git grep -n -w -- 'invalidateCache' origin/main → 1 hits, all definition/unrelated same-name locals; commit 3608447 |
| 146 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/cloud-code/config-store.ts:47:14 | DEFAULT_SCOPE | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 147 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/connectors/secrets.ts:17:17 | secretIdFor | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 148 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/connectors/store.ts:23:23 | readRegistry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 149 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/pipeline-config.ts:83:14 | TOOL_ICON_MAP | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 150 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/pipeline-config.ts:126:14 | PHASE_DISPLAY_META | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 151 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/pipeline-config.ts:447:14 | PIPELINE_PHASES | REMOVED | git grep -n -w -- 'PIPELINE_PHASES' origin/main → 2 hits, all definition/unrelated same-name locals; commit f3ef1e4 |
| 152 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/schedule.ts:40:17 | scheduleNameFor | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 153 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/store.ts:23:10 | DEFAULT_USER_ID | REMOVED | git grep -n -w -- 'DEFAULT_USER_ID' origin/main → 23 hits, all definition/unrelated same-name locals; commit aa416ae |
| 154 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/store.ts:23:27 | DEFAULT_TENANT_ID | REMOVED | git grep -n -w -- 'DEFAULT_TENANT_ID' origin/main → 45 hits, all definition/unrelated same-name locals; commit aa416ae |
| 155 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/store.ts:37:23 | getRoutine | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 156 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/utils.ts:8:17 | formatDuration | REMOVED | git grep -n -w -- 'formatDuration' origin/main → 9 hits, all definition/unrelated same-name locals; commit 52f0225 |
| 157 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/utils.ts:15:17 | truncate | REMOVED | git grep -n -w -- 'truncate' origin/main → 54 hits, all definition/unrelated same-name locals; commit 52f0225 |
| 158 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/intake.ts:19:10 | redactUrl | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 159 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/jira-client.ts:11:14 | JIRA_STATUS_TO_INTERNAL | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 160 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/jira-client.ts:25:14 | INTERNAL_STATUS_TO_JIRA | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 161 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:83:14 | FLEET_KPIS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 162 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:101:14 | BASELINE_DAYS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 163 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:102:14 | BASELINE_MIN | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 164 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:113:17 | quantile | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 165 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:154:17 | getPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 166 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:217:17 | isValidCard | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 167 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/roster-loader.ts:22:23 | loadRoster | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 168 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/source-shape.ts:29:14 | INTAKE_SOURCE_TYPES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 169 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/workflow-defs.ts:280:17 | sdlcFrameworkForDef | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 170 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/workflow-defs.ts:285:17 | isHumanAssignee | REMOVED | git grep -n -w -- 'isHumanAssignee' origin/main → 10 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 171 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/workspace.ts:36:23 | writeArtifact | REMOVED | git grep -n -w -- 'writeArtifact' origin/main → 1 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 172 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/artifacts.ts:45:13 | ArtifactKind | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 173 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/artifacts.ts:47:18 | ArtifactCandidate | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 174 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/cli-config.ts:26:13 | ServerCategory | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 175 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/cli-config.ts:27:13 | ServerTransport | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 176 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/cli-config.ts:36:18 | ClassifiedServer | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 177 | knip-root, ts-prune-root | Unused exported types, Unused export | src/components/workflow/useWorkflowStream.ts:6:13 | StreamStatus | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 178 | knip-root, ts-prune-root | Unused exported types, Unused export | src/config/modules.ts:28:13 | ModuleId | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 179 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/agentcore-sdk.ts:910:13 | RegistryAuthorizerType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 180 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/connectors/types.ts:33:13 | ConnectorStatus | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 181 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:93:13 | PipelinePhaseId | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 182 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:99:18 | PipelineIdentityItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 183 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:104:18 | PipelineConfigItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 184 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:109:18 | PipelineDisplayItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 185 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:244:18 | PipelineAgentConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 186 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline/status.ts:23:18 | CiBuildSummary | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 187 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline/status.ts:32:18 | StageState | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 188 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/routines/types.ts:19:18 | RoutineRepoConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 189 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/routines/types.ts:48:18 | RoutineLastRun | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 190 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:13:13 | AnalysisTrigger | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 191 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:19:13 | FindingKind | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 192 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:20:13 | FindingSeverity | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 193 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:21:13 | RecommendationPriority | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 194 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:22:13 | RecommendationType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 195 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:29:18 | PhaseMetric | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 196 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:37:18 | AgentTaskMetric | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 197 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:48:18 | HumanReviewMetric | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 198 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:67:18 | FixTicketEntry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 199 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:84:18 | ChangeRequestCycle | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 200 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:91:18 | ManagerIntervention | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 201 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:98:18 | WorkflowMetrics | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 202 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:139:18 | AnalysisScores | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 203 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:165:18 | AnalysisTrend | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 204 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/command-queue.ts:23:18 | WorkflowCommand | REMOVED | git grep -n -w -- 'WorkflowCommand' origin/main → 1 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 205 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/completion-evidence.ts:21:18 | CompletionRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 206 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/intake.ts:75:13 | SourceOutcome | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 207 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/intake.ts:104:13 | LookupImpl | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 208 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:18:13 | ModelProvider | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 209 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:26:18 | ModelOptionBase | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 210 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:44:18 | BedrockModelOption | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 211 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:52:18 | OpenAIModelOption | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 212 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:45:18 | InfraSnapshot | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 213 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:70:18 | KpiDef | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 214 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:161:18 | KpiStat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 215 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:174:18 | AgentAgg | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 216 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/roster-loader.ts:12:18 | RosterAgent | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 217 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/ship-review.ts:18:18 | ShipFindingLike | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 218 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:106:18 | FixContract | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 219 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:134:13 | AgentPhase | REMOVED | git grep -n -w -- 'AgentPhase' origin/main → 1 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 220 | knip-root | Unused exported types | src/lib/workflow/types.ts:153:13 | WorkflowPhase | KEEP-referenced | 11 non-definition hits; first: src/components/workflow/PipelineVisualization.tsx:4 |
| 221 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:217:18 | StoredEvent | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 222 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:222:13 | WorkflowType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 223 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:281:18 | RepoTarget | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 224 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:290:13 | MessageType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 225 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:292:18 | AgentMessage | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 226 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:304:13 | IntakeSourceType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 227 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:412:18 | PortedSession | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 228 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:427:13 | NotificationType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 229 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:436:18 | ReviewPackageLink | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 230 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:20:13 | WorkflowPhaseType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 231 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:22:18 | WorkflowDefPhase | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 232 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:92:18 | ArtifactChainEntry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 233 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:109:18 | ArtifactChain | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 234 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:126:18 | FrameworkOverlay | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 235 | knip-root, knip-mcp-hub | Duplicate exports | mcp/hub/src/workflow/schemas.ts | WorkflowInputSchema | KEEP-policy | mcp/hub ts-prune twin: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 236 | knip-root | Configuration hints | knip.json | [src/app/**/page.tsx, …]           knip.json  Remove, or move unused top-level entry to one of "workspaces" | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 237 | knip-root | Configuration hints | knip.json | [src/**/*.{ts,tsx}, …]             knip.json  Remove, or move unused top-level project to one of "workspaces" | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 238 | knip-root | Configuration hints | knip.json | src/index.ts              mcp/hub  knip.json  Remove redundant entry pattern | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 239 | knip-mcp-hub | Configuration hints | knip.json | src/index.ts  mcp/hub  knip.json  Remove redundant entry pattern | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 240 | ts-prune-root | Unused export | playwright.config.ts:40 | default | KEEP-referenced | 1052 non-definition hits; first: .claude-plugin/README.md:54 |
| 241 | ts-prune-root | Unused export | vitest.config.ts:14 | default | KEEP-referenced | 1052 non-definition hits; first: .claude-plugin/README.md:54 |
| 242 | ts-prune-root | Unused export | demo/playwright.config.ts:14 | default | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 243 | ts-prune-root | Unused export | src/middleware.ts:56 | middleware | KEEP-H1 | Next.js convention export |
| 244 | ts-prune-root | Unused export | src/middleware.ts:87 | config | KEEP-H1 | Next.js convention export |
| 245 | ts-prune-root | Unused export | demo/playwright/playwright.config.ts:3 | default | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 246 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:92 | notTerminalPhaseGuard | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 247 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:116 | notTerminalPhaseFilter | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 248 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:147 | missingEvidenceTickets | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 249 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:243 | resolveMissingEvidenceFromRecords | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 250 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:297 | normalizeAdvisoryRoutingMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 251 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:323 | advisoryNeverApplies | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 252 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:338 | isAdvisoryTicket | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 253 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:345 | nonAdvisory | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 254 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:360 | isWorkflowComplete | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 255 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:466 | shipVerdictOf | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 256 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:498 | evaluateShipVerdict | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 257 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:35 | FIX_KINDS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 258 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:45 | REWORK_FIX_KINDS | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 259 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:56 | SHIP_BLOCKED_OUTCOMES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 260 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:75 | TERMINAL_WORKFLOW_PHASES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 261 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:131 | SHIP_PHASES | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 262 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:83 | lastAgentActivity | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 263 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:133 | lastStreamedText | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 264 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:178 | hasAgentErrorSince | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 265 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:214 | stealClaim | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 266 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:42 | DEFAULT_TTL_MINUTES | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 267 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:43 | STALE_CLAIM_MULTIPLIER | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 268 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:51 | LEASE_TTL_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 269 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:119 | fingerprintFinding | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 270 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:146 | roundContentFingerprint | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 271 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:164 | openEscalation | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 272 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:192 | parseDecision | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 273 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:300 | buildRoundRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 274 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:471 | createReviewCap | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 275 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:469 | REVIEW_CAP_FAIL_OPEN_LIMIT | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 276 | ts-prune-root | Unused export | src/app/layout.tsx:18 | default | KEEP-H1 | Next.js convention export |
| 277 | ts-prune-root | Unused export | src/app/layout.tsx:13 | metadata | KEEP-H1 | Next.js convention export |
| 278 | ts-prune-root | Unused export | src/app/page.tsx:58 | default | KEEP-H1 | Next.js convention export |
| 279 | ts-prune-root | Unused export | src/config/modules.ts:39 | NavItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 280 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:152 | DiscoveredAgent | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 281 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:169 | DiscoveredMemory | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 282 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:510 | PayloadFormat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 283 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:912 | Registry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 284 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:925 | RegistryRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 285 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:939 | RegistryRecordDetail | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 286 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:946 | CreateRegistryInput | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 287 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:955 | CreateRegistryRecordInput | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 288 | ts-prune-root | Unused export | src/lib/agentcore-stream.ts:19 | StreamRequest | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 289 | ts-prune-root | Unused export | src/lib/agentcore-stream.ts:43 | BuilderStreamRequest | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 290 | ts-prune-root | Unused export | src/lib/cd-registry.ts:44 | DeliveryMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 291 | ts-prune-root | Unused export | demo/playwright/v4/playwright-v4.config.ts:3 | default | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 292 | ts-prune-root | Unused export | deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx:7 | ThemeToggle | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 293 | ts-prune-root | Unused export | deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx:7 | ThemeToggle | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 294 | ts-prune-root | Unused export | evals/battery/lib/agent-runner.mjs:46 | MAX_TRANSPORT_RETRIES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 295 | ts-prune-root | Unused export | evals/battery/lib/cases.mjs:133 | duplicateCaseIds | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 296 | ts-prune-root | Unused export | evals/battery/lib/cases.mjs:13 | SCORING_BACKEND | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 297 | ts-prune-root | Unused export | evals/battery/lib/scoring.mjs:98 | createConverseTransport | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=8 |
| 298 | ts-prune-root | Unused export | evals/battery/lib/scoring.mjs:15 | SCORING_BACKEND | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=8 |
| 299 | ts-prune-root | Unused export | src/app/agents/page.tsx:57 | default | KEEP-H1 | Next.js convention export |
| 300 | ts-prune-root | Unused export | src/app/build/page.tsx:17 | default | KEEP-H1 | Next.js convention export |
| 301 | ts-prune-root | Unused export | src/app/cloud-code/page.tsx:49 | default | KEEP-H1 | Next.js convention export |
| 302 | ts-prune-root | Unused export | src/app/connectors/page.tsx:22 | default | KEEP-H1 | Next.js convention export |
| 303 | ts-prune-root | Unused export | src/app/evaluations/page.tsx:113 | default | KEEP-H1 | Next.js convention export |
| 304 | ts-prune-root | Unused export | src/app/invoke/page.tsx:27 | default | KEEP-H1 | Next.js convention export |
| 305 | ts-prune-root | Unused export | src/app/pipeline/page.tsx:38 | default | KEEP-H1 | Next.js convention export |
| 306 | ts-prune-root | Unused export | src/app/registry/page.tsx:80 | default | KEEP-H1 | Next.js convention export |
| 307 | ts-prune-root | Unused export | src/app/routines/page.tsx:19 | default | KEEP-H1 | Next.js convention export |
| 308 | ts-prune-root | Unused export | src/app/tickets/page.tsx:118 | default | KEEP-H1 | Next.js convention export |
| 309 | ts-prune-root | Unused export | src/app/workflow/page.tsx:36 | default | KEEP-H1 | Next.js convention export |
| 310 | ts-prune-root | Unused export | src/components/workflow/ArtifactViewer.tsx:20 | ArtifactKind | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 311 | ts-prune-root | Unused export | src/components/workflow/PipelineVisualization.tsx:333 | default | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 312 | ts-prune-root | Unused export | src/components/workflow/useWorkflowStream.ts:8 | UseWorkflowStreamOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 313 | ts-prune-root | Unused export | src/components/workflow/useWorkflowStream.ts:26 | UseWorkflowStreamReturn | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 314 | ts-prune-root | Unused export | src/lib/cloud-code/config-store.ts:52 | UserConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 315 | ts-prune-root | Unused export | src/lib/cloud-code/github-store.ts:31 | GithubConnection | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 316 | ts-prune-root | Unused export | src/lib/cloud-code/runtime.ts:36 | CodingTurnResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 317 | ts-prune-root | Unused export | src/lib/cloud-code/runtime.ts:47 | CodingTurnParams | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 318 | ts-prune-root | Unused export | src/lib/cloud-code/shell-protocol.ts:21 | DecodedFrame | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 319 | ts-prune-root | Unused export | src/lib/cloud-code/use-voice-input.ts:49 | VoiceInput | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 320 | ts-prune-root | Unused export | src/lib/metrics/gate-dwell.ts:15 | StatusTransition | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 321 | ts-prune-root | Unused export | src/lib/metrics/throughput.ts:10 | WorkflowDuration | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 322 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:32 | BedrockApiFormat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 323 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:33 | OpenAiApiFormat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 324 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:36 | HarnessModelConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 325 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:51 | ModelProvider | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 326 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:53 | HarnessModelOption | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 327 | ts-prune-root | Unused export | src/lib/pipeline/status.ts:44 | PipelineStatus | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 328 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:32 | EvidenceEntryLike | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 329 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:41 | MissingEvidenceTicket | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 330 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:46 | BackfillFields | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 331 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:53 | ResolveEvidenceDeps | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 332 | ts-prune-root | Unused export | src/lib/workflow/intake.ts:97 | SourceValidationMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 333 | ts-prune-root | Unused export | src/lib/workflow/intake.ts:108 | ValidateIntakeSourcesOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 334 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:60 | JiraClientConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 335 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:66 | JiraIssue | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 336 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:91 | JiraTransition | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 337 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:97 | JiraSearchResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 338 | ts-prune-root | Unused export | src/lib/workflow/lease.ts:42 | AgentTaskEntry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 339 | ts-prune-root | Unused export | src/lib/workflow/performance.ts:125 | Band | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 340 | ts-prune-root | Unused export | src/lib/workflow/repo-check.ts:21 | RepoCheckResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 341 | ts-prune-root | Unused export | src/lib/workflow/repo-check.ts:38 | RepoCheckOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 342 | ts-prune-root | Unused export | src/lib/workflow/sdlc-framework.ts:9 | SdlcFramework | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 343 | ts-prune-root | Unused export | src/lib/workflow/ship-review.ts:52 | EffectiveRoundCountOpts | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 344 | ts-prune-root | Unused export | src/lib/workflow/source-shape.ts:105 | SourceDisplay | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 345 | ts-prune-root | Unused export | src/lib/workflow/transform-event.ts:11 | TransformOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 346 | ts-prune-root | Unused export | src/lib/workflow/watchdog.ts:27 | WatchdogConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 347 | ts-prune-root | Unused export | src/lib/workflow/watchdog.ts:34 | PartialWatchdog | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 348 | ts-prune-root | Unused export | src/lib/workflow/workflow-defs.ts:116 | SdlcFramework | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 349 | ts-prune-root | Unused export | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:10 | parseSession | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=5 |
| 350 | ts-prune-root | Unused export | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:26 | getTenantScope | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=5 |
| 351 | ts-prune-root | Unused export | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:4 | Session | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 352 | ts-prune-root | Unused export | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts:10 | paginate | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=3 |
| 353 | ts-prune-root | Unused export | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts:3 | Page | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 354 | ts-prune-root | Unused export | evals/battery/fixtures/fix-race-condition-cas-003/store.ts:5 | ConversationRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 355 | ts-prune-root | Unused export | evals/battery/fixtures/fix-race-condition-cas-003/store.ts:19 | ConversationStore | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=4 |
| 356 | ts-prune-root | Unused export | src/app/agents/[id]/page.tsx:60 | default | KEEP-H1 | Next.js convention export |
| 357 | ts-prune-root | Unused export | src/app/api/connectors/route.ts:27 | GET | KEEP-H1 | Next.js convention export |
| 358 | ts-prune-root | Unused export | src/app/api/connectors/route.ts:37 | POST | KEEP-H1 | Next.js convention export |
| 359 | ts-prune-root | Unused export | src/app/api/connectors/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 360 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:42 | GET | KEEP-H1 | Next.js convention export |
| 361 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:14 | dynamic | KEEP-H1 | Next.js convention export |
| 362 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:15 | revalidate | KEEP-H1 | Next.js convention export |
| 363 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:16 | fetchCache | KEEP-H1 | Next.js convention export |
| 364 | ts-prune-root | Unused export | src/app/api/health/route.ts:3 | GET | KEEP-H1 | Next.js convention export |
| 365 | ts-prune-root | Unused export | src/app/api/models/route.ts:40 | GET | KEEP-H1 | Next.js convention export |
| 366 | ts-prune-root | Unused export | src/app/api/routines/route.ts:22 | GET | KEEP-H1 | Next.js convention export |
| 367 | ts-prune-root | Unused export | src/app/api/routines/route.ts:36 | POST | KEEP-H1 | Next.js convention export |
| 368 | ts-prune-root | Unused export | src/app/api/routines/route.ts:20 | dynamic | KEEP-H1 | Next.js convention export |
| 369 | ts-prune-root | Unused export | src/app/evaluations/config/page.tsx:85 | default | KEEP-H1 | Next.js convention export |
| 370 | ts-prune-root | Unused export | src/app/api/agentcore/agents/route.ts:11 | GET | KEEP-H1 | Next.js convention export |
| 371 | ts-prune-root | Unused export | src/app/api/agentcore/builder/route.ts:13 | POST | KEEP-H1 | Next.js convention export |
| 372 | ts-prune-root | Unused export | src/app/api/agentcore/deploy/route.ts:12 | POST | KEEP-H1 | Next.js convention export |
| 373 | ts-prune-root | Unused export | src/app/api/agentcore/invoke/route.ts:9 | POST | KEEP-H1 | Next.js convention export |
| 374 | ts-prune-root | Unused export | src/app/api/agentcore/metrics/route.ts:94 | GET | KEEP-H1 | Next.js convention export |
| 375 | ts-prune-root | Unused export | src/app/api/agentcore/metrics/route.ts:3 | dynamic | KEEP-H1 | Next.js convention export |
| 376 | ts-prune-root | Unused export | src/app/api/agentcore/payload-format/route.ts:8 | GET | KEEP-H1 | Next.js convention export |
| 377 | ts-prune-root | Unused export | src/app/api/agentcore/payload-format/route.ts:21 | POST | KEEP-H1 | Next.js convention export |
| 378 | ts-prune-root | Unused export | src/app/api/agentcore/region/route.ts:19 | GET | KEEP-H1 | Next.js convention export |
| 379 | ts-prune-root | Unused export | src/app/api/agentcore/region/route.ts:31 | POST | KEEP-H1 | Next.js convention export |
| 380 | ts-prune-root | Unused export | src/app/api/agentcore/registry/route.ts:10 | GET | KEEP-H1 | Next.js convention export |
| 381 | ts-prune-root | Unused export | src/app/api/agentcore/registry/route.ts:26 | POST | KEEP-H1 | Next.js convention export |
| 382 | ts-prune-root | Unused export | src/app/api/agentcore/registry/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 383 | ts-prune-root | Unused export | src/app/api/agentcore/traces/route.ts:71 | GET | KEEP-H1 | Next.js convention export |
| 384 | ts-prune-root | Unused export | src/app/api/agentcore/traces/route.ts:126 | POST | KEEP-H1 | Next.js convention export |
| 385 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:37 | GET | KEEP-H1 | Next.js convention export |
| 386 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:43 | POST | KEEP-H1 | Next.js convention export |
| 387 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:106 | PUT | KEEP-H1 | Next.js convention export |
| 388 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:30 | dynamic | KEEP-H1 | Next.js convention export |
| 389 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:31 | maxDuration | KEEP-H1 | Next.js convention export |
| 390 | ts-prune-root | Unused export | src/app/api/cloud-code/github/route.ts:16 | GET | KEEP-H1 | Next.js convention export |
| 391 | ts-prune-root | Unused export | src/app/api/cloud-code/github/route.ts:43 | DELETE | KEEP-H1 | Next.js convention export |
| 392 | ts-prune-root | Unused export | src/app/api/cloud-code/github/route.ts:14 | dynamic | KEEP-H1 | Next.js convention export |
| 393 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/route.ts:14 | GET | KEEP-H1 | Next.js convention export |
| 394 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/route.ts:35 | POST | KEEP-H1 | Next.js convention export |
| 395 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/route.ts:12 | dynamic | KEEP-H1 | Next.js convention export |
| 396 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:16 | GET | KEEP-H1 | Next.js convention export |
| 397 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:23 | PATCH | KEEP-H1 | Next.js convention export |
| 398 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:64 | DELETE | KEEP-H1 | Next.js convention export |
| 399 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:14 | dynamic | KEEP-H1 | Next.js convention export |
| 400 | ts-prune-root | Unused export | src/app/api/evaluations/agents/route.ts:6 | GET | KEEP-H1 | Next.js convention export |
| 401 | ts-prune-root | Unused export | src/app/api/evaluations/agents/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 402 | ts-prune-root | Unused export | src/app/api/evaluations/loop/route.ts:55 | GET | KEEP-H1 | Next.js convention export |
| 403 | ts-prune-root | Unused export | src/app/api/evaluations/loop/route.ts:75 | POST | KEEP-H1 | Next.js convention export |
| 404 | ts-prune-root | Unused export | src/app/api/evaluations/loop/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 405 | ts-prune-root | Unused export | src/app/api/jira/metrics/route.ts:546 | GET | KEEP-H1 | Next.js convention export |
| 406 | ts-prune-root | Unused export | src/app/api/jira/metrics/route.ts:6 | dynamic | KEEP-H1 | Next.js convention export |
| 407 | ts-prune-root | Unused export | src/app/api/pipeline/status/route.ts:9 | GET | KEEP-H1 | Next.js convention export |
| 408 | ts-prune-root | Unused export | src/app/api/pipeline/status/route.ts:7 | dynamic | KEEP-H1 | Next.js convention export |
| 409 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:20 | GET | KEEP-H1 | Next.js convention export |
| 410 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:31 | PATCH | KEEP-H1 | Next.js convention export |
| 411 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:86 | DELETE | KEEP-H1 | Next.js convention export |
| 412 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:18 | dynamic | KEEP-H1 | Next.js convention export |
| 413 | ts-prune-root | Unused export | src/app/api/routines/chat/route.ts:38 | POST | KEEP-H1 | Next.js convention export |
| 414 | ts-prune-root | Unused export | src/app/api/routines/chat/route.ts:21 | runtime | KEEP-H1 | Next.js convention export |
| 415 | ts-prune-root | Unused export | src/app/api/routines/chat/route.ts:22 | dynamic | KEEP-H1 | Next.js convention export |
| 416 | ts-prune-root | Unused export | src/app/api/routines/definitions/route.ts:29 | GET | KEEP-H1 | Next.js convention export |
| 417 | ts-prune-root | Unused export | src/app/api/routines/definitions/route.ts:13 | dynamic | KEEP-H1 | Next.js convention export |
| 418 | ts-prune-root | Unused export | src/app/api/workflow/[id]/route.ts:33 | DELETE | KEEP-H1 | Next.js convention export |
| 419 | ts-prune-root | Unused export | src/app/api/workflow/[id]/route.ts:31 | dynamic | KEEP-H1 | Next.js convention export |
| 420 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/route.ts:4 | GET | KEEP-H1 | Next.js convention export |
| 421 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:27 | GET | KEEP-H1 | Next.js convention export |
| 422 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:41 | POST | KEEP-H1 | Next.js convention export |
| 423 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:62 | DELETE | KEEP-H1 | Next.js convention export |
| 424 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 425 | ts-prune-root | Unused export | src/app/api/workflow/definitions/route.ts:15 | GET | KEEP-H1 | Next.js convention export |
| 426 | ts-prune-root | Unused export | src/app/api/workflow/definitions/route.ts:13 | dynamic | KEEP-H1 | Next.js convention export |
| 427 | ts-prune-root | Unused export | src/app/api/workflow/list/route.ts:6 | GET | KEEP-H1 | Next.js convention export |
| 428 | ts-prune-root | Unused export | src/app/api/workflow/list/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 429 | ts-prune-root | Unused export | src/app/api/workflow/performance/route.ts:47 | GET | KEEP-H1 | Next.js convention export |
| 430 | ts-prune-root | Unused export | src/app/api/workflow/performance/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 431 | ts-prune-root | Unused export | src/app/api/workflow/state/route.ts:9 | GET | KEEP-H1 | Next.js convention export |
| 432 | ts-prune-root | Unused export | src/app/api/workflow/webhook/route.ts:21 | POST | KEEP-H1 | Next.js convention export |
| 433 | ts-prune-root | Unused export | src/app/api/workflow-manager/chat/route.ts:97 | POST | KEEP-H1 | Next.js convention export |
| 434 | ts-prune-root | Unused export | src/app/api/workflow-manager/chat/route.ts:24 | runtime | KEEP-H1 | Next.js convention export |
| 435 | ts-prune-root | Unused export | src/app/api/workflow-manager/chat/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 436 | ts-prune-root | Unused export | src/app/api/agentcore/memory/events/route.ts:26 | GET | KEEP-H1 | Next.js convention export |
| 437 | ts-prune-root | Unused export | src/app/api/agentcore/memory/events/route.ts:114 | POST | KEEP-H1 | Next.js convention export |
| 438 | ts-prune-root | Unused export | src/app/api/agentcore/memory/mapping/route.ts:14 | GET | KEEP-H1 | Next.js convention export |
| 439 | ts-prune-root | Unused export | src/app/api/agentcore/memory/mapping/route.ts:28 | POST | KEEP-H1 | Next.js convention export |
| 440 | ts-prune-root | Unused export | src/app/api/agentcore/memory/sessions/route.ts:24 | GET | KEEP-H1 | Next.js convention export |
| 441 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:12 | GET | KEEP-H1 | Next.js convention export |
| 442 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:28 | PATCH | KEEP-H1 | Next.js convention export |
| 443 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:44 | DELETE | KEEP-H1 | Next.js convention export |
| 444 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 445 | ts-prune-root | Unused export | src/app/api/agentcore/traces/health/route.ts:51 | GET | KEEP-H1 | Next.js convention export |
| 446 | ts-prune-root | Unused export | src/app/api/agentcore/traces/health/route.ts:17 | TraceHealthIssue | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 447 | ts-prune-root | Unused export | src/app/api/agentcore/traces/health/route.ts:30 | TraceHealth | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 448 | ts-prune-root | Unused export | src/app/api/agentcore/traces/sessions/route.ts:27 | GET | KEEP-H1 | Next.js convention export |
| 449 | ts-prune-root | Unused export | src/app/api/cloud-code/github/callback/route.ts:30 | GET | KEEP-H1 | Next.js convention export |
| 450 | ts-prune-root | Unused export | src/app/api/cloud-code/github/callback/route.ts:24 | dynamic | KEEP-H1 | Next.js convention export |
| 451 | ts-prune-root | Unused export | src/app/api/cloud-code/github/install/route.ts:21 | GET | KEEP-H1 | Next.js convention export |
| 452 | ts-prune-root | Unused export | src/app/api/cloud-code/github/install/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 453 | ts-prune-root | Unused export | src/app/api/cloud-code/github/manifest/route.ts:30 | GET | KEEP-H1 | Next.js convention export |
| 454 | ts-prune-root | Unused export | src/app/api/cloud-code/github/manifest/route.ts:24 | dynamic | KEEP-H1 | Next.js convention export |
| 455 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:61 | PATCH | KEEP-H1 | Next.js convention export |
| 456 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:87 | GET | KEEP-H1 | Next.js convention export |
| 457 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:104 | DELETE | KEEP-H1 | Next.js convention export |
| 458 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 459 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/port/route.ts:137 | POST | KEEP-H1 | Next.js convention export |
| 460 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/port/route.ts:48 | dynamic | KEEP-H1 | Next.js convention export |
| 461 | ts-prune-root | Unused export | src/app/api/connectors/[id]/credentials/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 462 | ts-prune-root | Unused export | src/app/api/connectors/[id]/credentials/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 463 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/route.ts:45 | PUT | KEEP-H1 | Next.js convention export |
| 464 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 465 | ts-prune-root | Unused export | src/app/api/routines/[id]/run/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 466 | ts-prune-root | Unused export | src/app/api/routines/[id]/run/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 467 | ts-prune-root | Unused export | src/app/api/workflow/[id]/agent-output/route.ts:73 | GET | KEEP-H1 | Next.js convention export |
| 468 | ts-prune-root | Unused export | src/app/api/workflow/[id]/agent-output/route.ts:32 | dynamic | KEEP-H1 | Next.js convention export |
| 469 | ts-prune-root | Unused export | src/app/api/workflow/[id]/analyze/route.ts:27 | POST | KEEP-H1 | Next.js convention export |
| 470 | ts-prune-root | Unused export | src/app/api/workflow/[id]/analyze/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 471 | ts-prune-root | Unused export | src/app/api/workflow/[id]/archive/route.ts:21 | PATCH | KEEP-H1 | Next.js convention export |
| 472 | ts-prune-root | Unused export | src/app/api/workflow/[id]/archive/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 473 | ts-prune-root | Unused export | src/app/api/workflow/[id]/escalations/route.ts:32 | GET | KEEP-H1 | Next.js convention export |
| 474 | ts-prune-root | Unused export | src/app/api/workflow/[id]/escalations/route.ts:45 | PATCH | KEEP-H1 | Next.js convention export |
| 475 | ts-prune-root | Unused export | src/app/api/workflow/[id]/escalations/route.ts:23 | dynamic | KEEP-H1 | Next.js convention export |
| 476 | ts-prune-root | Unused export | src/app/api/workflow/[id]/events/route.ts:22 | GET | KEEP-H1 | Next.js convention export |
| 477 | ts-prune-root | Unused export | src/app/api/workflow/[id]/events/route.ts:13 | dynamic | KEEP-H1 | Next.js convention export |
| 478 | ts-prune-root | Unused export | src/app/api/workflow/[id]/message/route.ts:30 | POST | KEEP-H1 | Next.js convention export |
| 479 | ts-prune-root | Unused export | src/app/api/workflow/[id]/message/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 480 | ts-prune-root | Unused export | src/app/api/workflow/[id]/nudge/route.ts:267 | POST | KEEP-H1 | Next.js convention export |
| 481 | ts-prune-root | Unused export | src/app/api/workflow/[id]/nudge/route.ts:32 | dynamic | KEEP-H1 | Next.js convention export |
| 482 | ts-prune-root | Unused export | src/app/api/workflow/[id]/retry/route.ts:151 | POST | KEEP-H1 | Next.js convention export |
| 483 | ts-prune-root | Unused export | src/app/api/workflow/[id]/retry/route.ts:73 | dynamic | KEEP-H1 | Next.js convention export |
| 484 | ts-prune-root | Unused export | src/app/api/workflow/[id]/state/route.ts:35 | GET | KEEP-H1 | Next.js convention export |
| 485 | ts-prune-root | Unused export | src/app/api/workflow/[id]/state/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 486 | ts-prune-root | Unused export | src/app/api/workflow/[id]/stream/route.ts:29 | GET | KEEP-H1 | Next.js convention export |
| 487 | ts-prune-root | Unused export | src/app/api/workflow/[id]/stream/route.ts:17 | runtime | KEEP-H1 | Next.js convention export |
| 488 | ts-prune-root | Unused export | src/app/api/workflow/[id]/stream/route.ts:18 | dynamic | KEEP-H1 | Next.js convention export |
| 489 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/route.ts:9 | GET | KEEP-H1 | Next.js convention export |
| 490 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/route.ts:5 | dynamic | KEEP-H1 | Next.js convention export |
| 491 | ts-prune-root | Unused export | src/app/api/workflow/[id]/watch/route.ts:23 | GET | KEEP-H1 | Next.js convention export |
| 492 | ts-prune-root | Unused export | src/app/api/workflow/[id]/watch/route.ts:33 | PATCH | KEEP-H1 | Next.js convention export |
| 493 | ts-prune-root | Unused export | src/app/api/workflow/[id]/watch/route.ts:21 | dynamic | KEEP-H1 | Next.js convention export |
| 494 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/content/route.ts:51 | GET | KEEP-H1 | Next.js convention export |
| 495 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/content/route.ts:93 | PUT | KEEP-H1 | Next.js convention export |
| 496 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/download/route.ts:11 | GET | KEEP-H1 | Next.js convention export |
| 497 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/route.ts:18 | GET | KEEP-H1 | Next.js convention export |
| 498 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/route.ts:43 | POST | KEEP-H1 | Next.js convention export |
| 499 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/route.ts:10 | dynamic | KEEP-H1 | Next.js convention export |
| 500 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/search/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 501 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/search/route.ts:8 | dynamic | KEEP-H1 | Next.js convention export |
| 502 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:61 | GET | KEEP-H1 | Next.js convention export |
| 503 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:121 | POST | KEEP-H1 | Next.js convention export |
| 504 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:24 | dynamic | KEEP-H1 | Next.js convention export |
| 505 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:30 | POST | KEEP-H1 | Next.js convention export |
| 506 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:23 | dynamic | KEEP-H1 | Next.js convention export |
| 507 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:24 | maxDuration | KEEP-H1 | Next.js convention export |
| 508 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/message/route.ts:55 | POST | KEEP-H1 | Next.js convention export |
| 509 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/message/route.ts:20 | dynamic | KEEP-H1 | Next.js convention export |
| 510 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/message/route.ts:22 | maxDuration | KEEP-H1 | Next.js convention export |
| 511 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/shell/route.ts:32 | POST | KEEP-H1 | Next.js convention export |
| 512 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/shell/route.ts:22 | dynamic | KEEP-H1 | Next.js convention export |
| 513 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/shell/route.ts:26 | maxDuration | KEEP-H1 | Next.js convention export |
| 514 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/stop/route.ts:42 | POST | KEEP-H1 | Next.js convention export |
| 515 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/stop/route.ts:35 | dynamic | KEEP-H1 | Next.js convention export |
| 516 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/stop/route.ts:36 | maxDuration | KEEP-H1 | Next.js convention export |
| 517 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/warm/route.ts:21 | POST | KEEP-H1 | Next.js convention export |
| 518 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/warm/route.ts:18 | dynamic | KEEP-H1 | Next.js convention export |
| 519 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/warm/route.ts:19 | maxDuration | KEEP-H1 | Next.js convention export |
| 520 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/flush/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 521 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/flush/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 522 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/comment/route.ts:29 | POST | KEEP-H1 | Next.js convention export |
| 523 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/comment/route.ts:27 | dynamic | KEEP-H1 | Next.js convention export |
| 524 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/transition/route.ts:24 | POST | KEEP-H1 | Next.js convention export |
| 525 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/transition/route.ts:7 | dynamic | KEEP-H1 | Next.js convention export |
| 526 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:17 | GET | KEEP-H1 | Next.js convention export |
| 527 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:34 | PATCH | KEEP-H1 | Next.js convention export |
| 528 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:67 | DELETE | KEEP-H1 | Next.js convention export |
| 529 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:9 | dynamic | KEEP-H1 | Next.js convention export |
| 530 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/approval/route.ts:24 | POST | KEEP-H1 | Next.js convention export |
| 531 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/approval/route.ts:9 | dynamic | KEEP-H1 | Next.js convention export |
| 532 | ts-prune-mcp-hub | Unused export | mcp/hub/src/auth.ts:109 | ClientResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 533 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/artifacts.ts:56 | DetectResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 534 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/artifacts.ts:181 | DetectOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 535 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/cli-config.ts:44 | GatherResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 536 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/git.ts:44 | GitState | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 537 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/git.ts:113 | GitHandoff | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 538 | depcheck-root | Unused dependencies | - | @aws-sdk/client-bedrock-agent-runtime | KEEP-H5 | git grep -n -l 'client-bedrock-agent-runtime' origin/main → 22 hits: lambda/orchestrator/advisory-routing.test.mjs, lambda/orchestrator/cd-handoff.test.mjs, lambda/orchestrator/ci-check-context.test.mjs |
| 539 | depcheck-root | Unused devDependencies | - | autoprefixer | KEEP-H5 | postcss.config / Tailwind toolchain (postcss configs=1: postcss.config.js) |
| 540 | depcheck-root | Unused devDependencies | - | depcheck | KEEP-H5 | sweep tooling, invoked via npx |
| 541 | depcheck-root | Unused devDependencies | - | knip | KEEP-H5 | sweep tooling, invoked via npx |
| 542 | depcheck-root | Unused devDependencies | - | postcss | KEEP-H5 | postcss.config / Tailwind toolchain (postcss configs=1: postcss.config.js) |
| 543 | depcheck-root | Unused devDependencies | - | ts-prune | KEEP-H5 | sweep tooling, invoked via npx |
| 544 | depcheck-root | Missing dependencies | ./evals/battery/lint-fixtures.mjs | ajv | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 545 | cascade | cascade orphan of writeArtifact | src/lib/workflow/agent-setup.ts:20 | getSharedArtifactsPrefix | REMOVED | cascade orphan of writeArtifact; git grep -n -w -- 'getSharedArtifactsPrefix' origin/main → 3 hits; commit ce9ba18 |

## 7. Removal Ledger detail

### formatDuration
commit: 52f0225
file: src/lib/utils.ts

`git grep -n -w -- 'formatDuration' origin/main`
```text
origin/main:src/app/agents/page.tsx:48:function formatDuration(seconds: number): string {
origin/main:src/app/agents/page.tsx:272:                    <p className="text-sm font-semibold text-secondary">{pending ? "—" : formatDuration(m.avgDuration)}</p>
origin/main:src/app/agents/page.tsx:279:                    <p className="text-lg font-bold text-success-fg">{pending ? "—" : formatDuration(m.totalDuration)}</p>
origin/main:src/app/page.tsx:48:function formatDuration(seconds: number): string {
origin/main:src/app/page.tsx:100:            value={metricsLoading ? "—" : formatDuration(metrics?.usage.avgSessionDuration ?? 0)}
origin/main:src/app/page.tsx:105:            value={metricsLoading ? "—" : formatDuration(metrics?.usage.totalDuration ?? 0)}
origin/main:src/app/page.tsx:187:                        <span className="text-base font-semibold text-[var(--color-text-primary)]">{pending ? "—" : formatDuration(am?.avgDuration || 0)}</span>
origin/main:src/app/page.tsx:190:                        <span className="text-lg font-bold text-success-fg">{pending ? "—" : formatDuration(am?.totalDuration || 0)}</span>
origin/main:src/lib/utils.ts:8:export function formatDuration(ms: number): string {
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename utils):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
(no hits)
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### truncate
commit: 52f0225
file: src/lib/utils.ts

`git grep -n -w -- 'truncate' origin/main`
```text
origin/main:deploy/pipeline/lib/pipeline-stack.ts:316:        // so a slow build can't truncate the rollback. (Even a truncated rollback
origin/main:deploy/telegram-bug-intake/index.mjs:434:    `${icon(bug)} *${esc(bug.title)}*\n\n${esc(truncate(bug.description, 300))}\n\nWhich repo?` +
origin/main:deploy/telegram-bug-intake/index.mjs:1850:function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }
origin/main:evals/battery/lib/report.mjs:10:const truncate = (s, max = EXPLANATION_MAX_CHARS) => {
origin/main:evals/battery/lib/report.mjs:131:      if (explanation) lines.push(`  - Judge: ${truncate(explanation)}`);
origin/main:evals/battery/lib/report.mjs:157:        if (detail?.explanation) lines.push(`  - ${evaluator}: ${truncate(detail.explanation)}`);
origin/main:lambda/eval-packager/lib/classify.mjs:17:function truncate(value, max) {
origin/main:lambda/eval-packager/lib/classify.mjs:107:    return { status: 'error', statusReason: truncate(reason, 500) };
origin/main:lambda/eval-packager/lib/classify.mjs:115:      statusReason: truncate(`judge declined to score (label=${e.scoreLabel})`, 500),
origin/main:lambda/eval-packager/lib/classify.mjs:173:      reason: truncate(reason, 500),
origin/main:src/app/agents/[id]/page.tsx:171:              <p className="text-secondary mt-0.5 font-mono text-[10px] truncate">{agent.memoryId}</p>
origin/main:src/app/agents/[id]/page.tsx:177:              <p className="text-secondary mt-0.5 font-mono text-[10px] truncate">{agent.logGroup}</p>
origin/main:src/app/agents/[id]/page.tsx:781:                  <span className="truncate font-mono text-[10px]">
origin/main:src/app/agents/[id]/page.tsx:812:            <p className="text-[9px] text-muted mt-1 truncate">{linkedMemory}</p>
origin/main:src/app/agents/[id]/page.tsx:1077:                      <span className="text-[11px] text-secondary block truncate">{step.name || config.label}</span>
origin/main:src/app/agents/page.tsx:183:                      <p className="text-base font-bold text-primary truncate">
origin/main:src/app/agents/page.tsx:212:                      <span className="text-muted flex items-center gap-1 truncate">
origin/main:src/app/agents/page.tsx:214:                        <span className="truncate">{agent.model.split("/").pop()?.split(":")[0] || agent.model}</span>
origin/main:src/app/cloud-code/page.tsx:777:                <span className="text-[13px] font-medium truncate flex-1">{s.title}</span>
origin/main:src/app/cloud-code/page.tsx:800:                {s.repo && <span className="truncate">{s.repo.split("/").slice(-2).join("/")}</span>}
origin/main:src/app/cloud-code/page.tsx:857:                <div className="font-semibold text-[13.5px] truncate">{active.title}</div>
origin/main:src/app/cloud-code/page.tsx:959:                              <Paperclip className="w-3 h-3" /> <span className="max-w-[160px] truncate">{a.name}</span>
origin/main:src/app/cloud-code/page.tsx:1021:                        <Paperclip className="w-3 h-3" /> <span className="max-w-[140px] truncate">{a.name}</span>
origin/main:src/app/cloud-code/page.tsx:1349:                <div className="text-[13px] font-medium truncate">
origin/main:src/app/cloud-code/page.tsx:1405:                <div className="text-[13px] font-mono truncate">{v.version}</div>
origin/main:src/app/page.tsx:166:                          <span className="text-sm text-[var(--color-text-primary)] font-semibold truncate max-w-[200px]">{agent.name}</span>
origin/main:src/app/registry/page.tsx:468:                        <p className="text-sm font-bold text-primary truncate">{r.name}</p>
origin/main:src/app/registry/page.tsx:477:                      <p className="text-[10px] text-muted font-mono mt-1 truncate">
origin/main:src/app/tickets/page.tsx:309:                      <span className="text-xs text-secondary truncate">
origin/main:src/app/tickets/page.tsx:350:                    <p className="text-[10px] text-muted font-mono truncate">
origin/main:src/app/tickets/page.tsx:455:                            <span className="text-xs text-secondary truncate block">
origin/main:src/app/workflow/page.tsx:542:            <p className="text-xs font-medium text-[var(--color-text-primary)] truncate">
origin/main:src/app/workflow/page.tsx:598:                className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border border-[var(--color-border)] font-medium uppercase tracking-wider truncate"
origin/main:src/components/cloud-code/ArtifactsPanel.tsx:151:                <div className="text-[13px] font-medium truncate">{a.path}</div>
origin/main:src/components/dashboard/TicketsFlowPanel.tsx:414:                <span className="text-[10.5px] font-mono text-[var(--color-text-muted)] truncate">{it.key}</span>
origin/main:src/components/dashboard/TicketsFlowPanel.tsx:415:                <span className="text-[var(--color-text-secondary)] truncate" title={it.summary}>{it.summary}</span>
origin/main:src/components/layout/Header.tsx:92:        <h2 className="text-base md:text-lg font-semibold text-[var(--color-text-primary)] truncate">{title}</h2>
origin/main:src/components/registry/RecordDetailDrawer.tsx:136:                  <h3 className="text-base font-semibold text-primary truncate">{detail.name}</h3>
origin/main:src/components/registry/RecordDetailDrawer.tsx:271:      <p className={`text-secondary truncate ${mono ? "font-mono text-[11px]" : ""}`}>{value}</p>
origin/main:src/components/registry/RecordDetailDrawer.tsx:281:        <code className="text-[11px] text-secondary font-mono truncate flex-1">{value}</code>
origin/main:src/components/workflow/AgentOutputPanel.tsx:424:              className="modal-header-title truncate"
origin/main:src/components/workflow/AgentOutputPanel.tsx:600:                    className="px-2 py-0.5 rounded text-xs font-mono truncate max-w-[300px]"
origin/main:src/components/workflow/AgentOutputPanel.tsx:633:                    <span className="modal-footer-error truncate max-w-[400px]">
origin/main:src/components/workflow/IntakeForm.tsx:458:                <span className="text-secondary truncate flex-1">{source.value}</span>
origin/main:src/components/workflow/IntakeForm.tsx:580:                    <span className="text-muted flex-1 truncate">{e.pipeline ? `pipeline: ${e.pipeline}${e.region ? ` (${e.region})` : ""}` : `deploy doc: ${e.deployDoc || "DEPLOY.md"}`}</span>
origin/main:src/components/workflow/PerformanceCard.tsx:62:        <span className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)] truncate">{k.label}</span>
origin/main:src/components/workflow/PerformanceCard.tsx:251:                      <span className="truncate">{s.label}</span>
origin/main:src/components/workflow/PerformanceCard.tsx:289:                        <span className="truncate">{RUNTIME_LABEL(name)}</span>
origin/main:src/components/workflow/PerformanceCard.tsx:355:                      <div className="truncate" title={r.title || r.workflowId}>{r.title || r.workflowId}</div>
origin/main:src/components/workflow/S3ArtifactsModal.tsx:401:                                  className="text-[12px] font-medium text-[var(--pipeline-text)] truncate"
origin/main:src/components/workflow/TicketDetailModal.tsx:569:                <h2 id="ticket-modal-title" className="text-[14px] font-semibold text-primary truncate flex-1">
origin/main:src/components/workflow/WorkflowBoard.tsx:1496:                    <span className="truncate font-mono" title={display.label}>
origin/main:src/components/workflow/__tests__/SdlcBadge.presence.test.ts:78:        'className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border border-[var(--color-border)] font-medium uppercase tracking-wider truncate"'
origin/main:src/lib/utils.ts:15:export function truncate(str: string, maxLength: number): string {
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
origin/main:src/app/agents/page.tsx:214:                        <span className="truncate">{agent.model.split("/").pop()?.split(":")[0] || agent.model}</span>
origin/main:src/app/cloud-code/page.tsx:800:                {s.repo && <span className="truncate">{s.repo.split("/").slice(-2).join("/")}</span>}
origin/main:src/components/workflow/PerformanceCard.tsx:251:                      <span className="truncate">{s.label}</span>
origin/main:src/components/workflow/PerformanceCard.tsx:289:                        <span className="truncate">{RUNTIME_LABEL(name)}</span>
origin/main:src/components/workflow/PerformanceCard.tsx:355:                      <div className="truncate" title={r.title || r.workflowId}>{r.title || r.workflowId}</div>
```

H18 enclosing file source-text tests (basename utils):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
.github/workflows/config-evals-gate.yml:26:# BEFORE the 60000-char slice so it can never be truncated away. Never change
deploy/coding-agent-runtime/main.py:1881:        # cleanly with the same diagnostic on a corrupt/truncated file.)
deploy/coding-agent-runtime/test_turn_timeout.py:134:    def test_float_and_float_string_truncate_to_int(self):
deploy/evaluations/setup-evaluations.sh:196:# truncated, this script ABORTS instead of silently recreating
deploy/evaluations/setup-evaluations.sh:224:    echo "✗ ERROR: evaluator list appears TRUNCATED at --max-results 100 (the"
deploy/runtime-agent/main.py:340:        # Without an explicit cap, Bedrock's default (~4k) truncates multi-ticket
deploy/workflow-manager/skills/run-analysis/SKILL.md:47:model's output-token cap mid-call, the truncated tool input is discarded, and
deploy/workflow-manager/toolkit/events.py:25:not truncated to seconds.
deploy/workflow-manager/toolkit/events.py:84:    # truncated to seconds: dropping the milliseconds can only ever merge more
deploy/workflow-manager/toolkit/pull_dossier.py:266:                c["summary"] = summary[:COMPLETION_SUMMARY_CAP] + "\n…[truncated]"
deploy/workflow-manager/toolkit/pull_dossier.py:267:                c["summaryTruncated"] = True
deploy/workflow-manager/toolkit/pull_dossier.py:278:    truncated = False
deploy/workflow-manager/toolkit/pull_dossier.py:283:                truncated = True
deploy/workflow-manager/toolkit/pull_dossier.py:286:        if truncated or not page.get("IsTruncated"):
deploy/workflow-manager/toolkit/pull_dossier.py:289:    return keys, truncated
deploy/workflow-manager/toolkit/pull_dossier.py:371:    artifacts, artifacts_truncated = get_artifacts(args.workflow_id)
deploy/workflow-manager/toolkit/pull_dossier.py:372:    if artifacts_truncated:
deploy/workflow-manager/toolkit/test_events.py:65:        truncated to the second. The key uses detail.timestamp precisely so that
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### invalidateCache
commit: 3608447
file: src/lib/client-cache.ts

`git grep -n -w -- 'invalidateCache' origin/main`
```text
origin/main:src/lib/client-cache.ts:75:export function invalidateCache(url: string) {
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename client-cache):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
(no hits)
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### PIPELINE_PHASES
commit: f3ef1e4
file: src/lib/pipeline-config.ts

`git grep -n -w -- 'PIPELINE_PHASES' origin/main`
```text
origin/main:src/lib/pipeline-config.ts:327:// ─── Derive PIPELINE_PHASES from agents.json + display metadata ─────────────
origin/main:src/lib/pipeline-config.ts:447:export const PIPELINE_PHASES: PipelinePhaseConfig[] = getPipelinePhases();
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename pipeline-config):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
(no hits)
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### DEFAULT_USER_ID
commit: aa416ae
file: src/lib/routines/store.ts

`git grep -n -w -- 'DEFAULT_USER_ID' origin/main`
```text
origin/main:src/app/api/cloud-code/sessions/[id]/message/route.ts:12:import { getOwnedSession, mutateSession, STOP_MARKER, DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/cloud-code/sessions";
origin/main:src/app/api/cloud-code/sessions/[id]/message/route.ts:113:  const userId = session.userId || DEFAULT_USER_ID;
origin/main:src/app/api/cloud-code/sessions/[id]/shell/route.ts:16:import { getOwnedSession, DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/cloud-code/sessions";
origin/main:src/app/api/cloud-code/sessions/[id]/shell/route.ts:67:    const userId = session.userId || DEFAULT_USER_ID;
origin/main:src/app/api/cloud-code/sessions/[id]/stop/route.ts:27:  DEFAULT_USER_ID,
origin/main:src/app/api/cloud-code/sessions/[id]/stop/route.ts:129:  const userId = session.userId || DEFAULT_USER_ID;
origin/main:src/app/api/cloud-code/sessions/[id]/warm/route.ts:12:import { getOwnedSession, DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/cloud-code/sessions";
origin/main:src/app/api/cloud-code/sessions/[id]/warm/route.ts:39:  const userId = session.userId || DEFAULT_USER_ID;
origin/main:src/lib/auth/identity.ts:29:export const DEFAULT_USER_ID = "default";
origin/main:src/lib/auth/identity.ts:74:    return { userId: DEFAULT_USER_ID, tenantId: DEFAULT_TENANT_ID, groups: [] };
origin/main:src/lib/cloud-code/config-store.ts:21:import { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";
origin/main:src/lib/cloud-code/config-store.ts:49:  userId: DEFAULT_USER_ID,
origin/main:src/lib/cloud-code/config-store.ts:63:  tenantId === DEFAULT_TENANT_ID && userId === DEFAULT_USER_ID
origin/main:src/lib/cloud-code/config-store.ts:64:    ? `config:${DEFAULT_USER_ID}`
origin/main:src/lib/cloud-code/github-store.ts:17:import { DEFAULT_TENANT_ID, DEFAULT_USER_ID } from "@/lib/auth/identity";
origin/main:src/lib/cloud-code/github-store.ts:41:  userId: string = DEFAULT_USER_ID
origin/main:src/lib/cloud-code/github-store.ts:64:  userId: string = DEFAULT_USER_ID
origin/main:src/lib/cloud-code/github-store.ts:73:  userId: string = DEFAULT_USER_ID
origin/main:src/lib/cloud-code/sessions.ts:29:import { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";
origin/main:src/lib/cloud-code/sessions.ts:31:export { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";
origin/main:src/lib/routines/store.ts:23:export { DEFAULT_USER_ID, DEFAULT_TENANT_ID } from "@/lib/auth/identity";
origin/main:src/middleware.ts:26:  DEFAULT_USER_ID,
origin/main:src/middleware.ts:72:    headers.set(USER_HEADER, DEFAULT_USER_ID);
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename store):
```text
src/lib/workflow/fix-contract-parity.test.ts:103:    sibling_scope: "do not touch the session store",
src/lib/workflow/fix-contract-parity.test.ts:187:        siblingScope: "do not touch the session store",
```

Docs/blueprints/prose mention:
```text
(no hits)
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### AgentPhase
commit: ce9ba18
file: src/lib/workflow/types.ts

`git grep -n -w -- 'AgentPhase' origin/main`
```text
origin/main:src/lib/workflow/types.ts:134:export type AgentPhase = "requirements" | "design" | "development" | "verification" | "review" | "ship";
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename types):
```text
src/components/workflow/__tests__/terminal-outcome-surfaces.test.ts:4:import { TERMINAL_PHASES, SHIP_BLOCKED_OUTCOMES, isTerminalPhase } from '@/lib/workflow/types';
src/components/workflow/__tests__/terminal-outcome-surfaces.test.ts:19: * expected values are DERIVED from the shared lists in src/lib/workflow/types.ts,
src/components/workflow/__tests__/terminal-outcome-surfaces.test.ts:51:    expect(boardContent).toMatch(/import\s*\{[^}]*isTerminalPhase[^}]*\}\s*from\s*['"]@\/lib\/workflow\/types['"]/);
src/components/workflow/__tests__/terminal-outcome-surfaces.test.ts:163:  it('the orchestrator really publishes those detail-types on a blocked close', () => {
src/lib/workflow/fix-contract-parity.test.ts:38:// eslint-disable-next-line @typescript-eslint/no-explicit-any
src/lib/workflow/fix-contract-parity.test.ts:46:// eslint-disable-next-line @typescript-eslint/no-explicit-any
```

Docs/blueprints/prose mention:
```text
deploy/routine-builder/toolkit/list_fleet_agents.py:61:        "phases": [{"id": p.get("id"), "name": p.get("name"), "agentPhase": p.get("agentPhase")} for p in w.get("phases", [])],
deploy/routine-builder/toolkit/upsert_workflow_def.py:18:    "completionRequiresAgentPhases": ["analysis", "planning"],
deploy/routine-builder/toolkit/upsert_workflow_def.py:20:      {"id": "intake", "name": "Intake", "type": "app", "agentPhase": "intake"},
deploy/routine-builder/toolkit/upsert_workflow_def.py:21:      {"id": "analysis", "name": "Analysis", "type": "agent", "agentPhase": "analysis"},
deploy/routine-builder/toolkit/upsert_workflow_def.py:30:`app` intake phase, and every agentPhase referenced must have at least one agent
deploy/routine-builder/toolkit/upsert_workflow_def.py:92:            if ph.get("agentPhase") not in agent_phases:
deploy/routine-builder/toolkit/upsert_workflow_def.py:94:                    f"phase '{ph.get('id')}' (agentPhase='{ph.get('agentPhase')}') has no agent "
deploy/workflow-manager/toolkit/fixtures/sffzti-dossier.json:255:"completionRequiresAgentPhases":[
deploy/workflow-manager/toolkit/fixtures/sffzti-dossier.json:280:"agentPhase":"intake"
deploy/workflow-manager/toolkit/fixtures/sffzti-dossier.json:286:"agentPhase":"requirements"
deploy/workflow-manager/toolkit/fixtures/sffzti-dossier.json:292:"agentPhase":"development"
deploy/workflow-manager/toolkit/fixtures/sffzti-dossier.json:298:"agentPhase":"verification",
deploy/workflow-manager/toolkit/fixtures/sffzti-dossier.json:299:"extraAgentPhases":[
deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json:381:"completionRequiresAgentPhases":[
deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json:406:"agentPhase":"intake"
deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json:412:"agentPhase":"requirements"
deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json:418:"agentPhase":"development"
deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json:424:"agentPhase":"verification",
deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json:425:"extraAgentPhases":[
src/config/workflows.json:15:      "completionRequiresAgentPhases": [
src/config/workflows.json:58:          "agentPhase": "intake"
src/config/workflows.json:64:          "agentPhase": "requirements"
src/config/workflows.json:70:          "agentPhase": "design"
src/config/workflows.json:76:          "agentPhase": "development"
src/config/workflows.json:82:          "agentPhase": "verification",
src/config/workflows.json:83:          "extraAgentPhases": [
src/config/workflows.json:202:      "completionRequiresAgentPhases": [
src/config/workflows.json:227:          "agentPhase": "intake"
src/config/workflows.json:233:          "agentPhase": "requirements"
src/config/workflows.json:239:          "agentPhase": "development"
src/config/workflows.json:245:          "agentPhase": "verification",
src/config/workflows.json:246:          "extraAgentPhases": [
src/config/workflows.json:265:      "completionRequiresAgentPhases": [
src/config/workflows.json:276:          "agentPhase": "intake"
src/config/workflows.json:282:          "agentPhase": "development"
src/config/workflows.json:288:          "agentPhase": "verification",
src/config/workflows.json:289:          "extraAgentPhases": [
src/config/workflows.json:322:      "completionRequiresAgentPhases": [
src/config/workflows.json:331:          "agentPhase": "intake"
src/config/workflows.json:337:          "agentPhase": "strategy"
src/config/workflows.json:343:          "agentPhase": "creative"
src/config/workflows.json:349:          "agentPhase": "generation"
src/config/workflows.json:355:          "agentPhase": "verification"
src/config/workflows.json:361:          "agentPhase": "scheduling"
src/config/workflows.json:376:      "completionRequiresAgentPhases": [
src/config/workflows.json:386:          "agentPhase": "intake"
src/config/workflows.json:392:          "agentPhase": "qualification"
src/config/workflows.json:398:          "agentPhase": "drafting"
src/config/workflows.json:404:          "agentPhase": "review"
src/config/workflows.json:410:          "agentPhase": "approval"
src/config/workflows.json:425:      "completionRequiresAgentPhases": [
src/config/workflows.json:446:          "agentPhase": "intake"
src/config/workflows.json:452:          "agentPhase": "triage"
src/config/workflows.json:458:          "agentPhase": "review"
src/config/workflows.json:464:          "agentPhase": "redline"
src/config/workflows.json:470:          "agentPhase": "signoff"
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### WorkflowCommand
commit: ce9ba18
file: src/lib/workflow/command-queue.ts

`git grep -n -w -- 'WorkflowCommand' origin/main`
```text
origin/main:src/lib/workflow/command-queue.ts:23:export interface WorkflowCommand {
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename command-queue):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
deploy/ecs-express/deploy.sh:308:        \"Sid\": \"WorkflowCommandQueue\",
scripts/create-command-queue.sh:63:  --policy-name "WorkflowCommandQueueConsume" \
scripts/create-command-queue.sh:72:echo "  ✓ WorkflowCommandQueueConsume on $LAMBDA_ROLE_NAME"
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### isHumanAssignee
commit: ce9ba18
file: src/lib/workflow/workflow-defs.ts

`git grep -n -w -- 'isHumanAssignee' origin/main`
```text
origin/main:lambda/orchestrator/index.mjs:1514:      if (rejected && isHumanAssignee(rejected.assignee)) {
origin/main:lambda/orchestrator/index.mjs:1708:function isHumanAssignee(assignee) {
origin/main:lambda/orchestrator/index.mjs:1736:  if (!isHumanAssignee(assignee)) return false;
origin/main:lambda/orchestrator/index.mjs:1818:  if (!isHumanAssignee(assignee)) return;
origin/main:lambda/orchestrator/index.mjs:2618:  if (isHumanAssignee(ticket?.assignee)) return true;
origin/main:lambda/orchestrator/index.mjs:3294:  if (isHumanAssignee(assignee)) {
origin/main:lambda/orchestrator/index.mjs:3589:      if (isHumanAssignee(blockedAssignee)) {
origin/main:lambda/orchestrator/index.mjs:3758:  if (isHumanAssignee(assignee)) {
origin/main:lambda/orchestrator/index.mjs:3900:  if (isHumanAssignee(assignee)) return true;
origin/main:src/lib/workflow/workflow-defs.ts:285:export function isHumanAssignee(assignee?: string | null): boolean {
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename workflow-defs):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
(no hits)
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### writeArtifact
commit: ce9ba18
file: src/lib/workflow/workspace.ts

`git grep -n -w -- 'writeArtifact' origin/main`
```text
origin/main:src/lib/workflow/workspace.ts:36:export async function writeArtifact(params: {
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename workspace):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
(no hits)
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

### getSharedArtifactsPrefix
commit: ce9ba18
file: src/lib/workflow/agent-setup.ts

`git grep -n -w -- 'getSharedArtifactsPrefix' origin/main`
```text
origin/main:src/lib/workflow/agent-setup.ts:20:export function getSharedArtifactsPrefix(workflowId: string): string {
origin/main:src/lib/workflow/workspace.ts:15:import { ARTIFACT_BUCKET, getWorkflowS3Prefix, getSharedArtifactsPrefix } from "./agent-setup";
origin/main:src/lib/workflow/workspace.ts:46:    ? getSharedArtifactsPrefix(params.workflowId)
```

string single-quote refs:
```text
(no hits)
```

string double-quote refs:
```text
(no hits)
```

H18 enclosing file source-text tests (basename agent-setup):
```text
(no hits)
```

Docs/blueprints/prose mention:
```text
(no hits)
```

Hazards adjudicated: H1 no; H2 no dynamic import/require/string ref unless shown above; H17 no parity-only dependency; H18 no enclosing-file source-text dependency unless shown above; H7/H20 no docs/blueprint prose mention unless shown above.

## 8. Gate table

gates2 summary table:
```text
gate | command | exit code
--- | --- | ---
01-npm-ci | npm ci | 0
02-lint | npm run lint | 0
03-tsc | npx tsc --noEmit | 0
04-test-unit | npm run test:unit | 1
05-cost-report | node --test lambda/cost-report | 0
06-agentcore-hub-jira | node --test lambda/agentcore-hub-jira | 0
07-anomaly-watcher | node --test lambda/anomaly-watcher | 0
08-check-workflow-writes | ./scripts/check-workflow-writes.sh | 0
09-check-fix-kinds-parity | ./scripts/check-fix-kinds-parity.sh | 0
10-check-deploy-surfaces | ./scripts/check-deploy-surfaces.sh | 0
11-build | npm run build | 0
12-lambda-zip-manifest | bash scripts/check-lambda-zip-manifest.sh | 0
13-mcp-hub-build | npm --prefix mcp/hub run build | 0
14-test-cloud-code | start server on 3737; wait health; PLAYWRIGHT_BASE_URL=http://localhost:3737 npm run test:cloud-code; kill server | 1
15-npm-test | timeout 600 npm test | 1
16-test-full | timeout 600 npm run test:full | 1
```

Selected exit files:
```text
04-test-unit.exit: 1
04b-test-unit.exit: 143
04c-test-unit.exit: 1
04d-test-unit-excl.exit: 0
04e-gate-hardening-alone.exit: 1
04f-test-unit.exit: 0
14-test-cloud-code.exit: 1
14b-test-cloud-code.exit: 0
15-npm-test.exit: 1
16-test-full.exit: 1
```

04 root cause: deploy/lib/check-eval-gate.sh:335 uses `true </dev/tty` and then `read -r answer </dev/tty`; this blocks under a controlling PTY. CI/no controlling tty takes the non-interactive branch. 04f used `setsid -w bash -c 'npm run test:unit </dev/null ...'` and passed.
### 04f summary
```text
1982:{"_aws":{"Timestamp":1788788198303,"CloudWatchMetrics":[{"Namespace":"AgentCoreHub/Orchestrator","Dimensions":[[]],"Metrics":[{"Name":"ReconcileSweepDurationMs","Unit":"Milliseconds"},{"Name":"ReconcileSweepCandidates","Unit":"Count"},{"Name":"ReconcileSkippedLiveLease","Unit":"Count"},{"Name":"ReconcileRedispatch","Unit":"Count"},{"Name":"ReconcileEscalations","Unit":"Count"},{"Name":"ReconcileEscalationHeld","Unit":"Count"},{"Name":"ReconcileReviewReawaken","Unit":"Count"},{"Name":"ReconcileWouldRedispatch","Unit":"Count"},{"Name":"ReconcileNoop","Unit":"Count"},{"Name":"ReconcileCandidateErrors","Unit":"Count"},{"Name":"ReconcileSweepTruncated","Unit":"Count"}]}]},"ReconcileMode":"enforce","ReconcileSweepDurationMs":0,"ReconcileSweepCandidates":1,"ReconcileSkippedLiveLease":0,"ReconcileRedispatch":1,"ReconcileEscalations":0,"ReconcileEscalationHeld":0,"ReconcileReviewReawaken":0,"ReconcileWouldRedispatch":0,"ReconcileNoop":0,"ReconcileCandidateErrors":0,"ReconcileSweepTruncated":0}
1985:{"_aws":{"Timestamp":1788788198304,"CloudWatchMetrics":[{"Namespace":"AgentCoreHub/Orchestrator","Dimensions":[[]],"Metrics":[{"Name":"ReconcileSweepDurationMs","Unit":"Milliseconds"},{"Name":"ReconcileSweepCandidates","Unit":"Count"},{"Name":"ReconcileSkippedLiveLease","Unit":"Count"},{"Name":"ReconcileRedispatch","Unit":"Count"},{"Name":"ReconcileEscalations","Unit":"Count"},{"Name":"ReconcileEscalationHeld","Unit":"Count"},{"Name":"ReconcileReviewReawaken","Unit":"Count"},{"Name":"ReconcileWouldRedispatch","Unit":"Count"},{"Name":"ReconcileNoop","Unit":"Count"},{"Name":"ReconcileCandidateErrors","Unit":"Count"},{"Name":"ReconcileSweepTruncated","Unit":"Count"}]}]},"ReconcileMode":"enforce","ReconcileSweepDurationMs":0,"ReconcileSweepCandidates":1,"ReconcileSkippedLiveLease":0,"ReconcileRedispatch":0,"ReconcileEscalations":1,"ReconcileEscalationHeld":0,"ReconcileReviewReawaken":0,"ReconcileWouldRedispatch":0,"ReconcileNoop":0,"ReconcileCandidateErrors":0,"ReconcileSweepTruncated":0}
2082:stdout | lambda/orchestrator/replay-yteqfl-sync-main.test.mjs > enforce — main moved and the merge conflicts (the TEAM-4106 case) > a bare { error } reply is a FAILURE: invokeTickets throws, sync-main fails open, and the text is logged
2748:stdout | lambda/orchestrator/ci-check-context.test.mjs > 2. ci:uncertifiable epic label > a provider that answers {error} is a FAILURE: labeled is not persisted, and the next dispatch retries
2754:stderr | lambda/orchestrator/ci-check-context.test.mjs > 2. ci:uncertifiable epic label > a provider that answers {error} is a FAILURE: labeled is not persisted, and the next dispatch retries
3845:{"_aws":{"Timestamp":1788788238607,"CloudWatchMetrics":[{"Namespace":"AgentCoreHub/Orchestrator","Dimensions":[[]],"Metrics":[{"Name":"ReconcileSweepDurationMs","Unit":"Milliseconds"},{"Name":"ReconcileSweepCandidates","Unit":"Count"},{"Name":"ReconcileSkippedLiveLease","Unit":"Count"},{"Name":"ReconcileRedispatch","Unit":"Count"},{"Name":"ReconcileEscalations","Unit":"Count"},{"Name":"ReconcileEscalationHeld","Unit":"Count"},{"Name":"ReconcileReviewReawaken","Unit":"Count"},{"Name":"ReconcileWouldRedispatch","Unit":"Count"},{"Name":"ReconcileNoop","Unit":"Count"},{"Name":"ReconcileCandidateErrors","Unit":"Count"},{"Name":"ReconcileSweepTruncated","Unit":"Count"}]}]},"ReconcileMode":"enforce","ReconcileSweepDurationMs":0,"ReconcileSweepCandidates":6,"ReconcileSkippedLiveLease":0,"ReconcileRedispatch":5,"ReconcileEscalations":0,"ReconcileEscalationHeld":0,"ReconcileReviewReawaken":1,"ReconcileWouldRedispatch":0,"ReconcileNoop":0,"ReconcileCandidateErrors":0,"ReconcileSweepTruncated":0}
3848:{"_aws":{"Timestamp":1788788238609,"CloudWatchMetrics":[{"Namespace":"AgentCoreHub/Orchestrator","Dimensions":[[]],"Metrics":[{"Name":"ReconcileSweepDurationMs","Unit":"Milliseconds"},{"Name":"ReconcileSweepCandidates","Unit":"Count"},{"Name":"ReconcileSkippedLiveLease","Unit":"Count"},{"Name":"ReconcileRedispatch","Unit":"Count"},{"Name":"ReconcileEscalations","Unit":"Count"},{"Name":"ReconcileEscalationHeld","Unit":"Count"},{"Name":"ReconcileReviewReawaken","Unit":"Count"},{"Name":"ReconcileWouldRedispatch","Unit":"Count"},{"Name":"ReconcileNoop","Unit":"Count"},{"Name":"ReconcileCandidateErrors","Unit":"Count"},{"Name":"ReconcileSweepTruncated","Unit":"Count"}]}]},"ReconcileMode":"enforce","ReconcileSweepDurationMs":0,"ReconcileSweepCandidates":5,"ReconcileSkippedLiveLease":2,"ReconcileRedispatch":3,"ReconcileEscalations":0,"ReconcileEscalationHeld":0,"ReconcileReviewReawaken":0,"ReconcileWouldRedispatch":0,"ReconcileNoop":0,"ReconcileCandidateErrors":0,"ReconcileSweepTruncated":0}
4546: Test Files  145 passed (145)
4547:      Tests  2735 passed (2735)
4549:   Duration  130.76s (transform 4.79s, setup 0ms, collect 23.89s, tests 47.10s, environment 39ms, prepare 17.10s)
```

### 04f gate-hardening
```text
3513: ✓ deploy/lib/__tests__/gate-hardening.test.ts (12 tests) 1899ms
3514-   ✓ F3: belt cap fails closed > REFUSES at the cap when first-parent history extends beyond it (no anchor, no gated touch) 331ms
3515-   ✓ F3: belt cap fails closed > still proceeds informationally when the scan covered the FULL history (depth exactly at the cap) 335ms
3516- ✓ deploy/lib/__tests__/skipped-success-and-force.test.ts (12 tests) 564ms
```

### 14b tail
```text
  ✓  2 [chromium] › tests/cloud-code-ui.spec.ts:117:7 › Cloud Code UI (mocked) › send → stop button appears mid-stream, then clears on stop (883ms)
  ✓  3 [chromium] › tests/cloud-code-ui.spec.ts:167:7 › Cloud Code UI (mocked) › Artifacts tab renders the gallery from the list payload (957ms)
  ✓  4 [chromium] › tests/cloud-code-ui.spec.ts:194:7 › Cloud Code UI (mocked) › Artifacts tab shows the empty state with no artifacts (995ms)
  ✓  5 [chromium] › tests/cloud-code-ui.spec.ts:204:7 › Cloud Code UI (mocked) › pull-to-laptop button copies the exact MCP slash command (736ms)
  ✓  6 [chromium] › tests/cloud-code-ui.spec.ts:215:7 › Cloud Code UI (mocked) › GitHub section: Connect when app configured but not connected (912ms)
  ✓  7 [chromium] › tests/cloud-code-ui.spec.ts:226:7 › Cloud Code UI (mocked) › GitHub section: shows account + Disconnect when connected (741ms)

  7 passed (13.2s)
```

### 15 evidence
```text
51:    Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3000
68:    Error Context: test-results/e2e-api-routes-E2E-API-Rou-52b93-I-returns-discovered-agents-chromium/error-context.md
72:    Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3000
89:    Error Context: test-results/e2e-api-routes-E2E-API-Rou-db996-API-includes-harness-agents-chromium/error-context.md
93:    Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3000
```

### 16 evidence
```text
48:    Error: browserType.launch: Executable doesn't exist at /mnt/efs/sessions/cc-ce2dbee5d4e9429ea733f1b69c12c93d/tycenjmccann-agentcore-hub/node_modules/playwright-core/.local-browsers/chromium_headless_shell-1223/chrome-linux/headless_shell
58:    Error Context: test-results/tab-agents-Agents-Tab-renders-agents-page-chromium/error-context.md
62:    Error: browserType.launch: Executable doesn't exist at /mnt/efs/sessions/cc-ce2dbee5d4e9429ea733f1b69c12c93d/tycenjmccann-agentcore-hub/node_modules/playwright-core/.local-browsers/chromium_headless_shell-1223/chrome-linux/headless_shell
72:    Error Context: test-results/tab-agents-Agents-Tab-show-dbad3-ds-when-discovery-completes-chromium/error-context.md
76:    Error: browserType.launch: Executable doesn't exist at /mnt/efs/sessions/cc-ce2dbee5d4e9429ea733f1b69c12c93d/tycenjmccann-agentcore-hub/node_modules/playwright-core/.local-browsers/chromium_headless_shell-1223/chrome-linux/headless_shell
```

### earlier c883d08 gate exits
```text
0
0
0
0
0
0
0
0
0
0
0
0
0
0
```

## 9. Carry-forward list

- demo/playwright/test-s3-modal.spec.ts: kept 2026-08-31 by human decision (PR #239)
- demo/playwright/test-popup.spec.ts: kept 2026-08-31 by human decision (PR #239)
- demo/playwright/v4/record-demo-v4.spec.ts: kept 2026-08-31 by human decision (PR #239)
- demo/playwright/v4/test-lambda-orchestration.spec.ts: kept 2026-08-31 by human decision (PR #239)
- demo/playwright/v4/test-agent-streaming.spec.ts: kept 2026-08-31 by human decision (PR #239)
- demo/playwright/v4/check-layout.spec.ts: kept 2026-08-31 by human decision (PR #239)
- scripts/backfill-workflow-tombstones.mjs: kept 2026-08-31 by human decision (PR #239)
- src/components/workflow/PipelineVisualization.tsx: kept 2026-08-31 by human decision (PR #239)

## 10. Advisories

Recommendations only — nothing edited.
- knip.json scope gap vs vitest includes.
- deploy/pipeline + demo remain unswept.
- deploy/pipeline typecheck script / CI check, dependency hygiene notes, mcp/hub knip hint, and next start warnings:
$ grep -n typecheck deploy/pipeline/package.json .github/workflows/ci.yml deploy/pipeline/buildspec-ci.yml || true
```text
deploy/pipeline/package.json:13:    "typecheck": "tsc --noEmit"
```
$ git grep -n 'ajv/dist/2020' origin/main -- evals/battery/lint-fixtures.mjs evals/battery/lib/cases.mjs || true
```text
origin/main:evals/battery/lib/cases.mjs:91:    const Ajv2020 = require("ajv/dist/2020").default;
origin/main:evals/battery/lint-fixtures.mjs:53:  const Ajv2020 = require("ajv/dist/2020").default;
```
$ git grep -n 'js-yaml' origin/main -- lambda/anomaly-watcher/index.mjs || true
```text
origin/main:lambda/anomaly-watcher/index.mjs:25: * The AWS SDK and js-yaml are imported DYNAMICALLY (inside initClients/loadBands)
origin/main:lambda/anomaly-watcher/index.mjs:627:    const yaml = await import("js-yaml");
```
$ git grep -n '@smithy/node-http-handler' origin/main -- lambda/orchestrator/agent-invoker.mjs || true
```text
origin/main:lambda/orchestrator/agent-invoker.mjs:150:  const { NodeHttpHandler } = await import("@smithy/node-http-handler");
```
$ grep -n 'Remove redundant entry pattern' .sweep-output/knip-mcp-hub.txt || true
```text
30:src/index.ts  mcp/hub  knip.json  Remove redundant entry pattern
```
$ grep -n -E 'Unrecognized key|standalone' .sweep-output/gates2/14b-server.log || true
```text
10: ⚠     Unrecognized key(s) in object: 'outputFileTracingIncludes', 'serverExternalPackages'
12: ⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.
```

## 11. Files touched

Diff stat:
```text
 src/lib/client-cache.ts           |  7 -------
 src/lib/pipeline-config.ts        |  5 +----
 src/lib/routines/store.ts         |  2 --
 src/lib/utils.ts                  | 13 -------------
 src/lib/workflow/agent-setup.ts   |  7 -------
 src/lib/workflow/command-queue.ts |  7 -------
 src/lib/workflow/types.ts         |  4 ----
 src/lib/workflow/workflow-defs.ts |  5 -----
 src/lib/workflow/workspace.ts     | 34 ++--------------------------------
 9 files changed, 3 insertions(+), 81 deletions(-)
```

Changed files:
```text
src/lib/client-cache.ts
src/lib/pipeline-config.ts
src/lib/routines/store.ts
src/lib/utils.ts
src/lib/workflow/agent-setup.ts
src/lib/workflow/command-queue.ts
src/lib/workflow/types.ts
src/lib/workflow/workflow-defs.ts
src/lib/workflow/workspace.ts
```

Forbidden touched assertion (expected no matches):
```text
(no matches)
```

knip.json, tsconfig.json, vitest.config.ts, next.config.mjs, Dockerfile, .github/**, deploy/**, lambda/**, scripts/**, package.json, package-lock.json are untouched.
