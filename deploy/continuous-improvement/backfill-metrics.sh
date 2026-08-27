#!/usr/bin/env bash
# deploy/continuous-improvement/backfill-metrics.sh
#
# One-time backfill: reads historical token usage + eval scores from CW Logs
# and writes aggregated results to the agentcore-hub-eval-config DDB table.
#
# Run ONCE after deploying the subscription filter pipeline to populate
# historical data so the dashboard has immediate content.
#
# Usage: bash backfill-metrics.sh [--region us-east-1] [--days 7]
#
# ── Known limitations ────────────────────────────────────────────────────────
# - The eval pass reads at most 500 events per results log group (single
#   filter-log-events call, no pagination). On a busy group that is a SAMPLE
#   of recent history, not a census.
# - Eval writes use SET (overwrite) semantics: evalScores/evalSessionCount are
#   REPLACED wholesale with whatever the capped window contained.
#
# ── Do NOT use this script for the TEAM-3359 dependency_chain pollution ─────
# The dependency_chain_compliance_online scorecard was polluted by false 0.0
# verdicts (sessions that created no tickets scored as "Failed"; verified on
# agentcore_hub_requirements_analyst: sum 42.5 / count 240 as of 2026-08-27).
# Re-running this script is the WRONG cleanup tool, twice over:
#   1. SET-overwrite + the 500-event cap would destroy every HEALTHY
#      evaluator's rolling history for the agent to fix one bad key.
#   2. The pollution is not reconstructible from results logs anyway — a
#      false-positive 0.0 ("no tickets created") is indistinguishable from a
#      genuine 0.0 failure in the log records alone.
#
# Targeted reset runbook instead — run once, at CD time, AFTER the corrected
# rubric (NotApplicable 2.0) and the TEAM-3359 packager are deployed:
#
#   for agent in agentcore_hub_requirements_analyst \
#                agentcore_hub_qa_verifier \
#                agentcore_hub_ci_agent; do
#     aws dynamodb update-item \
#       --table-name agentcore-hub-eval-config \
#       --key "{\"agentId\":{\"S\":\"$agent\"}}" \
#       --update-expression 'REMOVE evalScores.#e' \
#       --expression-attribute-names '{"#e":"dependency_chain_compliance_online"}'
#   done
#
# Notes (verified against the live table, 2026-08-27):
# - The evalScores map key is the BARE evaluator name
#   "dependency_chain_compliance_online" — no "-XXXX" ID suffix.
# - Only requirements_analyst currently carries the pollution; qa_verifier and
#   ci_agent have empty evalScores, so the REMOVE is a safe no-op there.
# - lambda/eval-packager (aggregateScoresToDdb) re-initializes a missing
#   evaluator key to {sum:0,count:0} on the next delivery; evalSessionCount is
#   deliberately left untouched.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DAYS=7
TABLE_NAME="agentcore-hub-eval-config"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
AGENTS_FILE="${REPO_ROOT}/src/config/agents.json"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "=== Backfill Metrics to DDB ==="
echo "Region: ${REGION} | Days: ${DAYS} | Table: ${TABLE_NAME}"
echo ""

START_TIME=$(python3 -c "import time; print(int((time.time() - ${DAYS}*86400) * 1000))")
END_TIME=$(python3 -c "import time; print(int(time.time() * 1000))")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Process each agent
python3 -c "
import json, re, subprocess, sys, time

with open('${AGENTS_FILE}') as f:
    agents = json.load(f)['agents']

agents = [a for a in agents if a.get('evaluationsEnabled')]

for agent in agents:
    agent_id = agent['agentId']
    # Convention: agentId IS the runtime name (no separate harnessName field)
    harness = agent_id
    eval_config = agent.get('evalConfigName', '')

    print(f'\\n--- {agent_id} ---')

    # ─── Token Backfill ───────────────────────────────────────────────
    # Find runtime log group
    result = subprocess.run([
        'aws', 'logs', 'describe-log-groups',
        '--log-group-name-prefix', f'/aws/bedrock-agentcore/runtimes/{harness}-',
        '--query', 'logGroups[].logGroupName', '--output', 'json',
        '--region', '${REGION}'
    ], capture_output=True, text=True)

    runtime_groups = json.loads(result.stdout) if result.returncode == 0 else []
    # Pick the one ending in -DEFAULT
    runtime_lg = next((g for g in runtime_groups if g.endswith('-DEFAULT')), None)

    total_in = 0
    total_out = 0
    by_model = {}

    if runtime_lg:
        next_token = None
        pages = 0
        while pages < 10:
            cmd = [
                'aws', 'logs', 'filter-log-events',
                '--log-group-name', runtime_lg,
                '--start-time', '${START_TIME}',
                '--end-time', '${END_TIME}',
                '--filter-pattern', 'gen_ai.client.token.usage',
                '--limit', '10000',
                '--output', 'json', '--region', '${REGION}'
            ]
            if next_token:
                cmd += ['--next-token', next_token]

            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                break

            data = json.loads(result.stdout)
            for event in data.get('events', []):
                try:
                    msg = event.get('message', '')
                    brace = msg.find('{')
                    if brace < 0: continue
                    record = json.loads(msg[brace:])
                    token_type = record.get('gen_ai.token.type', '')
                    usage_obj = record.get('gen_ai.client.token.usage', {})
                    usage = float(usage_obj.get('Sum', 0)) if isinstance(usage_obj, dict) else 0
                    model = record.get('gen_ai.request.model', 'unknown')

                    if not usage: continue
                    if model not in by_model:
                        by_model[model] = {'input': 0, 'output': 0}
                    if token_type == 'input':
                        total_in += usage
                        by_model[model]['input'] += usage
                    elif token_type == 'output':
                        total_out += usage
                        by_model[model]['output'] += usage
                except:
                    pass

            next_token = data.get('nextToken')
            pages += 1
            if not next_token:
                break

        print(f'  Tokens: {int(total_in):,} in / {int(total_out):,} out ({pages} pages)')
    else:
        print(f'  Tokens: no runtime log group found')

    # ─── Eval Scores Backfill ─────────────────────────────────────────
    eval_scores = {}
    session_count = 0
    sessions_seen = set()

    if eval_config:
        result = subprocess.run([
            'aws', 'logs', 'describe-log-groups',
            '--log-group-name-prefix', f'/aws/bedrock-agentcore/evaluations/results/{eval_config}',
            '--query', 'logGroups[].logGroupName', '--output', 'json',
            '--region', '${REGION}'
        ], capture_output=True, text=True)

        eval_groups = json.loads(result.stdout) if result.returncode == 0 else []

        for eval_lg in eval_groups:
            # KNOWN LIMITATION: single call, 500-event cap, no pagination —
            # a sample of recent history on busy groups (see script header).
            result = subprocess.run([
                'aws', 'logs', 'filter-log-events',
                '--log-group-name', eval_lg,
                '--start-time', '${START_TIME}',
                '--end-time', '${END_TIME}',
                '--limit', '500',
                '--output', 'json', '--region', '${REGION}'
            ], capture_output=True, text=True)

            if result.returncode != 0: continue
            data = json.loads(result.stdout)

            for event in data.get('events', []):
                try:
                    record = json.loads(event.get('message', '{}'))
                    attrs = record.get('attributes', {})
                    evaluator = attrs.get('gen_ai.evaluation.name', '')
                    score = attrs.get('gen_ai.evaluation.score.value')
                    score_label = attrs.get('gen_ai.evaluation.score.label') or ''
                    explanation = attrs.get('gen_ai.evaluation.explanation') or ''
                    session_id = attrs.get('session.id', '')
                    # Mirrors the packager's error exclusion: every errorClass
                    # (throttled / span_missing_validation / tool_span_mapping
                    # / other) carries error.type, and throttled rows can carry
                    # a numeric-looking score that must never aggregate.
                    has_error = attrs.get('error') == 1 or attrs.get('error.type')

                    try:
                        numeric = float(score) if score is not None else None
                    except (TypeError, ValueError):
                        numeric = None

                    # Mirrors lambda/eval-packager isNotApplicable(): the
                    # NotApplicable rubric verdict (score 2.0 / NotApplicable
                    # label / NOT_APPLICABLE-prefixed explanation) means
                    # \"nothing to judge\" — never averaged into sum/count.
                    is_na = (
                        re.match(r'not[\s_-]?applicable\$', score_label.strip(), re.I) is not None
                        or numeric == 2.0
                        or explanation.startswith('NOT_APPLICABLE')
                    )

                    if session_id: sessions_seen.add(session_id)
                    if evaluator and not is_na and numeric is not None and not has_error:
                        if evaluator not in eval_scores:
                            eval_scores[evaluator] = {'sum': 0, 'count': 0}
                        eval_scores[evaluator]['sum'] += numeric
                        eval_scores[evaluator]['count'] += 1
                except:
                    pass

        session_count = len(sessions_seen)
        eval_count = sum(v['count'] for v in eval_scores.values())
        print(f'  Evals: {eval_count} scores across {len(eval_scores)} evaluators, {session_count} sessions')
    else:
        print(f'  Evals: no evalConfigName')

    # ─── Write to DDB ─────────────────────────────────────────────────
    # Build update expression
    expr_parts = []
    names = {}
    values = {}

    if total_in > 0 or total_out > 0:
        expr_parts.append('#tti = :tti')
        expr_parts.append('#tto = :tto')
        expr_parts.append('#tbm = :tbm')
        expr_parts.append('#tws = :tws')
        expr_parts.append('#tlea = :tlea')
        names['#tti'] = 'tokenTotalInput'
        names['#tto'] = 'tokenTotalOutput'
        names['#tbm'] = 'tokenByModel'
        names['#tws'] = 'tokenWindowStart'
        names['#tlea'] = 'tokenLastEventAt'
        values[':tti'] = {'N': str(int(total_in))}
        values[':tto'] = {'N': str(int(total_out))}
        # tokenByModel as DDB Map
        bm_map = {}
        for model, usage in by_model.items():
            bm_map[model] = {'M': {'input': {'N': str(int(usage['input']))}, 'output': {'N': str(int(usage['output']))}}}
        values[':tbm'] = {'M': bm_map}
        values[':tws'] = {'S': '${NOW}'}
        values[':tlea'] = {'S': '${NOW}'}

    if eval_scores:
        expr_parts.append('#es = :es')
        expr_parts.append('#esc = :esc')
        expr_parts.append('#elsa = :elsa')
        names['#es'] = 'evalScores'
        names['#esc'] = 'evalSessionCount'
        names['#elsa'] = 'evalLastScoredAt'
        es_map = {}
        for evaluator, data in eval_scores.items():
            es_map[evaluator] = {'M': {'sum': {'N': str(round(data['sum'], 4))}, 'count': {'N': str(data['count'])}}}
        values[':es'] = {'M': es_map}
        values[':esc'] = {'N': str(session_count)}
        values[':elsa'] = {'S': '${NOW}'}

    if not expr_parts:
        print(f'  DDB: nothing to write')
        continue

    update_expr = 'SET ' + ', '.join(expr_parts)

    cmd = [
        'aws', 'dynamodb', 'update-item',
        '--table-name', '${TABLE_NAME}',
        '--key', json.dumps({'agentId': {'S': agent_id}}),
        '--update-expression', update_expr,
        '--expression-attribute-names', json.dumps(names),
        '--expression-attribute-values', json.dumps(values),
        '--region', '${REGION}', '--output', 'text'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print(f'  DDB: ✓ written')
    else:
        print(f'  DDB: ✗ {result.stderr[:200]}')

print(f'\\n=== Backfill Complete ===')
"
