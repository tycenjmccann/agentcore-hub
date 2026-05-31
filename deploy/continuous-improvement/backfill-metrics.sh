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
import json, subprocess, sys, time

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
                    session_id = attrs.get('session.id', '')
                    has_error = attrs.get('error') == 1 or attrs.get('error.type')

                    if session_id: sessions_seen.add(session_id)
                    if evaluator and score is not None and not has_error:
                        if evaluator not in eval_scores:
                            eval_scores[evaluator] = {'sum': 0, 'count': 0}
                        eval_scores[evaluator]['sum'] += float(score)
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
