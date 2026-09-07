#!/bin/sh
set +e
run_gate() {
  num="$1"; name="$2"; shift 2
  out=".sweep-output/gates/${num}-${name}.txt"
  printf 'RUN %s %s: %s\n' "$num" "$name" "$*" > "$out"
  "$@" >> "$out" 2>&1
  ec=$?
  printf '%s\n' "$ec" > ".sweep-output/gates/${num}-${name}.exit"
  printf 'DONE %s-%s exit=%s\n' "$num" "$name" "$ec"
  return 0
}

# 1 npm ci with one retry on failure
out=.sweep-output/gates/01-npm-ci.txt
printf 'RUN 1 npm-ci: npm ci --maxsockets 1\n' > "$out"
npm ci --maxsockets 1 >> "$out" 2>&1
ec=$?
if [ "$ec" -ne 0 ]; then
  printf '\nRETRY 1 npm-ci: npm ci --maxsockets 1\n' >> "$out"
  npm ci --maxsockets 1 >> "$out" 2>&1
  ec=$?
fi
printf '%s\n' "$ec" > .sweep-output/gates/01-npm-ci.exit
printf 'DONE 01-npm-ci exit=%s\n' "$ec"

run_gate 02 lint npm run lint
run_gate 03 tsc npx tsc --noEmit
run_gate 04 test-unit npm run test:unit
run_gate 05 cost-report node --test lambda/cost-report
run_gate 06 agentcore-hub-jira node --test lambda/agentcore-hub-jira
run_gate 07 anomaly-watcher node --test lambda/anomaly-watcher
run_gate 08 check-workflow-writes ./scripts/check-workflow-writes.sh
run_gate 09 check-fix-kinds-parity ./scripts/check-fix-kinds-parity.sh
run_gate 10 check-deploy-surfaces ./scripts/check-deploy-surfaces.sh
run_gate 11 build npm run build
run_gate 12 lambda-zip-manifest bash scripts/check-lambda-zip-manifest.sh
run_gate 13 mcp-hub-build npm --prefix mcp/hub run build

# 14 combined cloud smoke
out=.sweep-output/gates/14-cloud-smoke.txt
: > "$out"
printf 'RUN 14a playwright-install: npx playwright install chromium\n' >> "$out"
npx playwright install chromium >> "$out" 2>&1
play_ec=$?
printf '%s\n' "$play_ec" > .sweep-output/gates/14a-playwright-install.exit
printf '\nRUN 14b server: PORT=3737 npm run start -- -p 3737\n' >> "$out"
PORT=3737 npm run start -- -p 3737 > .sweep-output/gates/14-server.log 2>&1 &
server_pid=$!
printf 'server_pid=%s\n' "$server_pid" >> "$out"
ready=1
i=0
while [ "$i" -lt 60 ]; do
  curl -sf http://localhost:3737/api/health >> "$out" 2>&1
  if [ "$?" -eq 0 ]; then ready=0; break; fi
  sleep 1
  i=$((i+1))
done
printf '\nserver_ready_exit=%s after_seconds=%s\n' "$ready" "$i" >> "$out"
smoke_ec=0
for path in / /workflow /cloud-code /registry /agents /pipeline /api/pipeline/status /api/workflow/cd-registry /api/workflow/list; do
  code=$(curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3737${path}")
  curl_ec=$?
  printf '%s %s curl_exit=%s\n' "$path" "$code" "$curl_ec" >> "$out"
  if [ "$curl_ec" -ne 0 ]; then smoke_ec=1; fi
done
printf '\nRUN 14c test-cloud-code: npm run test:cloud-code\n' >> "$out"
npm run test:cloud-code >> "$out" 2>&1
tcc_ec=$?
printf '%s\n' "$tcc_ec" > .sweep-output/gates/14c-test-cloud-code.exit
printf '\nRUN 14d module-error-grep\n' >> "$out"
grep -nE "MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND" .sweep-output/gates/14-server.log | head >> "$out" 2>&1
grep_ec=$?
kill "$server_pid" >> "$out" 2>&1
wait "$server_pid" >> "$out" 2>&1
# aggregate 14: fail if playwright, readiness/smoke, or cloud-code failed
agg=0
[ "$play_ec" -ne 0 ] && agg=1
[ "$ready" -ne 0 ] && agg=1
[ "$smoke_ec" -ne 0 ] && agg=1
[ "$tcc_ec" -ne 0 ] && agg=1
printf '%s\n' "$agg" > .sweep-output/gates/14-cloud-smoke.exit
printf 'DONE 14-cloud-smoke exit=%s\n' "$agg"

# 15 env-block proof commands
out=.sweep-output/gates/15-npm-test.txt
printf 'RUN 15a npm-test: timeout 180 npm test\n' > "$out"
timeout 180 npm test >> "$out" 2>&1
ec=$?
printf '%s\n' "$ec" > .sweep-output/gates/15-npm-test.exit
printf 'DONE 15-npm-test exit=%s\n' "$ec"
out=.sweep-output/gates/15-test-full.txt
printf 'RUN 15b test-full: timeout 120 npm run test:full\n' > "$out"
timeout 120 npm run test:full >> "$out" 2>&1
ec=$?
printf '%s\n' "$ec" > .sweep-output/gates/15-test-full.exit
printf 'DONE 15-test-full exit=%s\n' "$ec"
