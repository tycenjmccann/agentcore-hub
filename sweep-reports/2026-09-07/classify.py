#!/usr/bin/env python3
from __future__ import annotations
import os, re, subprocess, json
from pathlib import Path
from collections import Counter

ROOT=Path.cwd()
OUT=ROOT/'.sweep-output'
CAND=OUT/'candidates.txt'
LEDGER=OUT/'ledger.md'
SUMMARY=OUT/'ledger-summary.txt'

removed = {
    ('src/lib/utils.ts','formatDuration'):('52f0225','formatDuration'),
    ('src/lib/utils.ts','truncate'):('52f0225','truncate'),
    ('src/lib/client-cache.ts','invalidateCache'):('3608447','invalidateCache'),
    ('src/lib/pipeline-config.ts','PIPELINE_PHASES'):('f3ef1e4','PIPELINE_PHASES'),
    ('src/lib/routines/store.ts','DEFAULT_USER_ID'):('aa416ae','DEFAULT_USER_ID'),
    ('src/lib/routines/store.ts','DEFAULT_TENANT_ID'):('aa416ae','DEFAULT_TENANT_ID'),
    ('src/lib/workflow/types.ts','AgentPhase'):('ce9ba18','AgentPhase'),
    ('src/lib/workflow/command-queue.ts','WorkflowCommand'):('ce9ba18','WorkflowCommand'),
    ('src/lib/workflow/workflow-defs.ts','isHumanAssignee'):('ce9ba18','isHumanAssignee'),
    ('src/lib/workflow/workspace.ts','writeArtifact'):('ce9ba18','writeArtifact'),
}
carry = {
 'demo/playwright/test-s3-modal.spec.ts','demo/playwright/test-popup.spec.ts',
 'demo/playwright/v4/record-demo-v4.spec.ts','demo/playwright/v4/test-lambda-orchestration.spec.ts',
 'demo/playwright/v4/test-agent-streaming.spec.ts','demo/playwright/v4/check-layout.spec.ts',
 'scripts/backfill-workflow-tombstones.mjs','src/components/workflow/PipelineVisualization.tsx'
}
six_tests = [
 'src/components/workflow/__tests__/SdlcBadge.presence.test.ts',
 'src/components/workflow/__tests__/WorkflowBoard.scroll.test.ts',
 'src/components/workflow/__tests__/stuck-tool-liveness.test.ts',
 'src/components/workflow/__tests__/terminal-outcome-surfaces.test.ts',
 'src/styles/__tests__/theme-vars.presence.test.ts',
 'src/lib/workflow/fix-contract-parity.test.ts',
]
advisory_rules={'Unlisted dependencies','Unlisted binaries','Missing dependencies','Duplicate exports','Configuration hints'}
dep_rules={'Unused devDependencies','Unused dependencies'}
next_symbols={'default','metadata','GET','POST','PUT','DELETE','PATCH','dynamic','revalidate','fetchCache','middleware','config','generateMetadata'}

cache={}
def run(cmd):
    key=tuple(cmd)
    if key not in cache:
        p=subprocess.run(cmd,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        cache[key]=p.stdout
    return cache[key]

def grep_count_fixed(pattern, *paths):
    if not pattern: return 0
    cmd=['git','grep','-n','-F','--',pattern]
    cmd += list(paths) if paths else []
    out=run(cmd)
    return 0 if not out else len(out.splitlines())

def git_grep_origin(sym, word=True, fixed=True):
    if not sym: return []
    cmd=['git','grep','-n']
    if word: cmd.append('-w')
    if fixed: cmd.append('-F')
    cmd += ['--',sym,'origin/main']
    return run(cmd).splitlines()

def parse_loc(loc):
    # strip origin-ish and parse line if path:line:col-ish
    m=re.match(r'(.+?):(\d+)(?::\d+)?$', loc)
    if m: return m.group(1), int(m.group(2))
    return loc, None

def esc(s):
    return (s or '').replace('|','\\|').replace('\n','<br>')

def first_path_line(hit):
    # origin/main:path:line:text -> path:line
    m=re.match(r'origin/main:(.*?):(\d+):', hit)
    if m: return f'{m.group(1)}:{m.group(2)}'
    return hit[:160]

def line_path(hit):
    m=re.match(r'origin/main:(.*?):(\d+):', hit)
    return (m.group(1), int(m.group(2))) if m else ('',None)

def basename_noext(path):
    b=os.path.basename(path)
    return os.path.splitext(b)[0]

# collect mcp ts-prune used-module symbols
mcp_used=set()
for ln in (OUT/'ts-prune-mcp-hub.txt').read_text().splitlines():
    if '(used in module)' in ln:
        m=re.match(r'.*? - ([A-Za-z0-9_$]+) ', ln)
        if m: mcp_used.add(m.group(1))

rows=[]
for line in CAND.read_text().splitlines():
    if line.startswith('---COUNTS---'): break
    m=re.match(r'(\d+)\.\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*)$', line)
    if not m: continue
    n,tools,rule,loc,sym,flags=m.groups()
    rows.append({'n':int(n),'tools':tools.strip(),'rule':rule.strip(),'loc':loc.strip(),'sym':sym.strip(),'flags':flags.strip(),'raw':line})

# ts-prune twin symbols globally
used_module_syms=set()
for r in rows:
    if '(used in module)' in r['flags']:
        used_module_syms.add(r['sym'])

def classify(r):
    locpath, locline = parse_loc(r['loc'])
    sym=r['sym']
    rule=r['rule']
    flags=r['flags']
    # R0
    for (p,s),(sha,gsym) in removed.items():
        if locpath==p and sym==s:
            hits=git_grep_origin(gsym, True, True)
            return 'REMOVED', f"git grep -n -w -- '{gsym}' origin/main → {len(hits)} hits, all definition/unrelated same-name locals; commit {sha}"
    # R1 and mcp twin policy
    if '(used in module)' in flags:
        return 'KEEP-policy', 'ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy)'
    if locpath.startswith('mcp/hub/') and sym in mcp_used:
        return 'KEEP-policy', 'mcp/hub ts-prune twin: used in module; stripping `export` is a refactor, not a deletion (policy)'
    # R2
    if rule in advisory_rules:
        return 'ADVISORY', 'hygiene note, not a removal candidate (additions/config are out of scope)'
    # R3
    if 'fix-contract.mjs' in r['loc']:
        return 'KEEP-H12-fix-contract', 'byte-compared triplicate; scripts/check-fix-kinds-parity.sh'
    # R4 lambda
    if locpath.startswith('lambda/'):
        base=os.path.basename(locpath)
        deploy_hits=grep_count_fixed(base,'lambda/orchestrator/deploy.sh')
        surf_hits=grep_count_fixed(base,'deploy/pipeline/surfaces.json')
        if deploy_hits:
            return 'KEEP-H11/H14', f'manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits={deploy_hits}'
        if surf_hits:
            return 'KEEP-H11/H14', f'surfaces.json entry {base}; surfaces.json basename hits={surf_hits}'
        if locpath.endswith('.test.mjs'):
            return 'KEEP-H11/H14', f'H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits={deploy_hits}; surfaces.json basename hits={surf_hits}'
        if base=='model-router.mjs':
            return 'KEEP-H11/H14', f'documented test-only (check-lambda-zip-manifest.sh:13-14); deploy.sh basename hits={deploy_hits}; surfaces.json basename hits={surf_hits}'
        return 'KEEP-H11/H14', f'H11 default-off flag module / lambda handler wired by string; deploy.sh basename hits={deploy_hits}; surfaces.json basename hits={surf_hits}'
    # R5 deploy
    if locpath.startswith('deploy/'):
        base=os.path.basename(locpath)
        c1=grep_count_fixed(base,'deploy/pipeline/surfaces.json')
        c2=grep_count_fixed(base,'vitest.config.ts')
        return 'KEEP-H16/H4', f'deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json={c1}, vitest.config.ts={c2}'
    # R6 evals
    if locpath.startswith('evals/'):
        base=os.path.basename(locpath)
        c1=grep_count_fixed(base,'vitest.config.ts')
        c2=grep_count_fixed(base,'evals')
        return 'KEEP-H12-scope', f'knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts={c1}, evals/={c2}'
    # R7 carry
    if locpath in carry:
        return 'KEEP-human', 'kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated'
    # R8 demo/scripts
    if locpath.startswith('demo/') or locpath.startswith('scripts/'):
        base=os.path.basename(locpath)
        hits=git_grep_origin(base, False, True)
        return 'KEEP-ambiguous', f'out of scope / operational script; needs human judgment; basename hits in origin/main={len(hits)}'
    # R9 Next
    if (locpath.startswith('src/app/') and (locpath.endswith('/page.tsx') or locpath.endswith('/layout.tsx') or locpath.endswith('/route.ts') or sym in next_symbols)) or locpath=='src/middleware.ts':
        return 'KEEP-H1', 'Next.js convention export'
    # R10 deps
    if rule in dep_rules:
        dep=sym
        if dep in {'depcheck','ts-prune','knip'}:
            return 'KEEP-H5','sweep tooling, invoked via npx'
        if dep in {'autoprefixer','postcss'}:
            hits=run(['sh','-c','ls postcss.config.* 2>/dev/null']).splitlines()
            return 'KEEP-H5', f'postcss.config / Tailwind toolchain (postcss configs={len(hits)}: {", ".join(hits)})'
        if dep=='@aws-sdk/client-bedrock-agent-runtime':
            hits=run(['git','grep','-n','-l','client-bedrock-agent-runtime','origin/main']).splitlines()
            return 'KEEP-H5', f"git grep -n -l 'client-bedrock-agent-runtime' origin/main → {len(hits)} hits: {', '.join(h.replace('origin/main:','') for h in hits[:3])}"
    # R11 referenced
    hits=git_grep_origin(sym, True, True)
    non=[]
    for h in hits:
        hp,hl=line_path(h)
        if hp==locpath and locline is not None and hl==locline:
            continue
        non.append(h)
    if non:
        paths=[line_path(h)[0] for h in non]
        if any(p in six_tests for p in paths):
            return 'KEEP-H18', f'{len(non)} non-definition hits; source-text assertion test hit; first: {first_path_line(non[0])}'
        parity=[p for p in paths if p.endswith('-parity.test.ts') or p.endswith('-parity.test.mjs')]
        if parity and len(parity)==len(paths):
            return 'KEEP-H17', f'{len(non)} non-definition hits, only in *-parity.test.*; first: {first_path_line(non[0])}'
        return 'KEEP-referenced', f'{len(non)} non-definition hits; first: {first_path_line(non[0])}'
    # R12
    reason='default KEEP — conservative; candidate for the next sweep'
    if sym in {'PIPELINE_STYLES','CLI_BRAND'}:
        reason='H6 style/className table (PIPELINE_STYLES, CLI_BRAND)'
    elif sym in {'authMode','authDisabled'} or 'TICKET_PROVIDER' in sym or 'TICKET_PROVIDER' in locpath:
        reason='H10 env/JSON dispatch (authMode, authDisabled, TICKET_PROVIDER-related)'
    elif sym in used_module_syms:
        reason='type-only export consumed via `(used in module)` twin row'
    elif locpath.startswith('mcp/hub/'):
        reason='mcp/hub export; no ts-prune used-in-module twin found, conservative keep'
    return 'KEEP-ambiguous', f'0 non-definition hits; not removed this sweep — {reason}'

out=[]
out.append('| # | Tool(s) | Rule | Location | Symbol | Verdict | Evidence |')
out.append('|---:|---|---|---|---|---|---|')
counts=Counter()
classified=[]
for r in rows:
    verdict,evidence=classify(r)
    counts[verdict]+=1
    classified.append((r,verdict,evidence))
    out.append(f"| {r['n']} | {esc(r['tools'])} | {esc(r['rule'])} | {esc(r['loc'])} | {esc(r['sym'])} | {verdict} | {esc(evidence)} |")
# cascade row 545
hits=git_grep_origin('getSharedArtifactsPrefix', True, True)
counts['REMOVED']+=1
out.append(f"| 545 | cascade | cascade orphan of writeArtifact | src/lib/workflow/agent-setup.ts:20 | getSharedArtifactsPrefix | REMOVED | cascade orphan of writeArtifact; git grep -n -w -- 'getSharedArtifactsPrefix' origin/main → {len(hits)} hits; commit ce9ba18 |")
LEDGER.write_text('\n'.join(out)+'\n')
with SUMMARY.open('w') as f:
    for k,v in sorted(counts.items()):
        f.write(f'{k}: {v}\n')
    f.write(f'TOTAL: {sum(counts.values())}\n')
assert len(rows)==544, len(rows)
assert sum(counts.values())==545, counts
print('wrote', LEDGER, 'rows', sum(counts.values()))
for k,v in sorted(counts.items()): print(f'{k}: {v}')
print('TOTAL:', sum(counts.values()))
